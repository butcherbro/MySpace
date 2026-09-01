//! Domain service for board lifecycle: child-board creation and rename.
//!
//! Child-board creation must be atomic (one transaction creating the board, its
//! view state, and its primary portal card), and idempotent under replay (same
//! IDs -> return existing aggregate, never duplicate). This is the only place
//! that enforces the board/portal invariants from Section C.

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::errors::WorkspaceError;
use crate::domain::models::CreateChildBoardInput;

use super::super::db;

/// The V1 board-identity palette tokens (deterministic, saturated, muted).
const COLOR_TOKENS: &[&str] = &["terracotta", "moss", "sky", "sand", "ink"];

/// Picks a deterministic `color_token` from the new board's id.
fn deterministic_color_token(board_id: &str) -> &'static str {
    let mut acc = 0u64;
    for b in board_id.bytes() {
        acc = acc.wrapping_mul(31).wrapping_add(b as u64);
    }
    COLOR_TOKENS[(acc % COLOR_TOKENS.len() as u64) as usize]
}

/// Creates a child board, its view state, and its primary portal card in one
/// transaction. Idempotent: replaying with the same IDs returns the existing
/// aggregate instead of creating duplicates. Conflicting ID reuse is an error.
pub fn create_child_board(
    conn: &mut Connection,
    input: &CreateChildBoardInput,
) -> Result<(), WorkspaceError> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err(WorkspaceError::ConstraintViolation(
            "board title must not be empty".into(),
        ));
    }

    let now = db::migrations::now_millis();
    let color = deterministic_color_token(&input.board_id);

    // Idempotent replay: if the board id already exists, verify it matches the
    // same parent and return without creating anything new.
    let existing_parent: Option<String> = conn
        .query_row(
            "SELECT parent_board_id FROM boards WHERE id = ?1",
            [input.board_id.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(parent) = existing_parent {
        if parent == input.parent_board_id {
            return Ok(());
        }
        return Err(WorkspaceError::ConstraintViolation(format!(
            "board id {} already exists",
            input.board_id
        )));
    }

    // The parent must exist and not be trashed.
    let parent_exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
        [input.parent_board_id.as_str()],
        |r| r.get(0),
    )?;
    if parent_exists == 0 {
        return Err(WorkspaceError::NotFound(input.parent_board_id.clone()));
    }

    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO boards (id, workspace_id, parent_board_id, title, color_token, symbol, revision, created_at, updated_at)
         VALUES (?1, (SELECT workspace_id FROM boards WHERE id = ?2), ?2, ?3, ?4, NULL, 1, ?5, ?5)",
        params![input.board_id, input.parent_board_id, title, color, now],
    )?;
    tx.execute(
        "INSERT INTO board_view_states (board_id, viewport_x, viewport_y, zoom, revision, updated_at)
         VALUES (?1, 0, 0, 1, 1, ?2)",
        params![input.board_id, now],
    )?;
    tx.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at)
         VALUES (?1, ?2, 'board_portal', ?3, ?4, ?5, ?6, 0, 1, ?7, ?7)",
        params![
            input.portal_card_id,
            input.parent_board_id,
            input.frame.x,
            input.frame.y,
            input.frame.width,
            input.frame.height,
            now,
        ],
    )?;
    tx.execute(
        "INSERT INTO board_portal_cards (card_id, target_board_id)
         VALUES (?1, ?2)",
        params![input.portal_card_id, input.board_id],
    )?;
    tx.commit()?;

    Ok(())
}

/// Renames a board in a transaction, bumping its revision. The portal title and
/// breadcrumbs derive from this record, so there is no duplicated title.
pub fn rename_board(
    conn: &mut Connection,
    board_id: &str,
    title: &str,
) -> Result<(), WorkspaceError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(WorkspaceError::ConstraintViolation(
            "board title must not be empty".into(),
        ));
    }
    if title.len() > 200 {
        return Err(WorkspaceError::ConstraintViolation(
            "board title must be at most 200 characters".into(),
        ));
    }

    let changed = conn.execute(
        "UPDATE boards SET title = ?1, revision = revision + 1, updated_at = ?2 WHERE id = ?3",
        params![title, db::migrations::now_millis(), board_id],
    )?;
    if changed == 0 {
        return Err(WorkspaceError::NotFound(board_id.to_string()));
    }
    Ok(())
}
