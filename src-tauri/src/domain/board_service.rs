//! Domain service for board lifecycle: child-board creation and rename.
//!
//! Child-board creation must be atomic (one transaction creating the board, its
//! view state, and its primary portal card), and idempotent under replay (same
//! IDs -> return existing aggregate, never duplicate). This is the only place
//! that enforces the board/portal invariants from Section C.

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{CreateChildBoardInput, MoveBoardInput};

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

/// Reparents a Board (and its unique portal card) to a new parent in one
/// transaction. Rejects Home moves, self-parenting, descendant cycles, missing or
/// trashed targets, and stale board/portal revisions. The moved subtree is
/// preserved (only `parent_board_id` changes); the portal card is relocated to
/// the destination frame on the new parent board.
pub fn move_board(conn: &mut Connection, input: &MoveBoardInput) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();

    // Source board must exist and be a non-root (movable) board.
    let (src_parent, src_workspace, src_revision): (Option<String>, String, i64) = conn
        .query_row(
            "SELECT parent_board_id, workspace_id, revision FROM boards WHERE id = ?1 AND deleted_at IS NULL",
            [input.board_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| WorkspaceError::NotFound(input.board_id.clone()))?;

    // Home (root) has no parent and cannot be moved.
    if src_parent.is_none() {
        return Err(WorkspaceError::RootBoardProtected);
    }

    if src_revision != input.expected_board_revision {
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_board_revision,
            actual: src_revision,
        });
    }

    // Target parent must be a live board in the same workspace.
    let target_workspace: String = conn
        .query_row(
            "SELECT workspace_id FROM boards WHERE id = ?1 AND deleted_at IS NULL",
            [input.target_parent_board_id.as_str()],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| WorkspaceError::NotFound(input.target_parent_board_id.clone()))?;
    if target_workspace != src_workspace {
        return Err(WorkspaceError::ConstraintViolation(
            "cannot move a board across workspaces".into(),
        ));
    }

    // Cycle guard: reject if the target parent lies inside the source subtree.
    let is_descendant: i64 = conn.query_row(
        "WITH RECURSIVE subtree(id, parent_board_id) AS (
            SELECT id, parent_board_id FROM boards WHERE id = ?1
            UNION ALL
            SELECT b.id, b.parent_board_id FROM boards b JOIN subtree s ON b.parent_board_id = s.id
         )
         SELECT COUNT(*) FROM subtree WHERE id = ?2",
        params![input.board_id, input.target_parent_board_id],
        |r| r.get(0),
    )?;
    // The source board itself satisfies `id = ?2` when target == board, so a
    // self-parent also lands here.
    if is_descendant > 0 {
        return Err(WorkspaceError::ConstraintViolation(
            "a board cannot become its own descendant".into(),
        ));
    }

    // Resolve the unique portal card by its target board id (do not trust a
    // frontend-supplied portal id).
    let (portal_card_id, portal_revision): (String, i64) = conn
        .query_row(
            "SELECT c.id, c.revision
             FROM board_portal_cards p JOIN cards c ON c.id = p.card_id
             WHERE p.target_board_id = ?1 AND c.deleted_at IS NULL",
            [input.board_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| {
            WorkspaceError::ConstraintViolation(format!(
                "board {} has no active portal card",
                input.board_id
            ))
        })?;

    if portal_revision != input.expected_portal_revision {
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_portal_revision,
            actual: portal_revision,
        });
    }

    // Place the relocated portal at a free slot on the target board rather than
    // a fixed origin, so a freshly dropped Board never stacks invisibly on top of
    // an existing card. A simple downward cascade below the lowest card.
    let (dest_x, dest_y) = next_free_position(conn, &input.target_parent_board_id);

    let tx = conn.transaction()?;

    let board_changed = tx.execute(
        "UPDATE boards SET parent_board_id = ?1, revision = revision + 1, updated_at = ?2 WHERE id = ?3 AND revision = ?4",
        params![
            input.target_parent_board_id,
            now,
            input.board_id,
            input.expected_board_revision
        ],
    )?;
    if board_changed == 0 {
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_board_revision,
            actual: src_revision,
        });
    }

    let portal_changed = tx.execute(
        "UPDATE cards SET board_id = ?1, x = ?2, y = ?3, revision = revision + 1, updated_at = ?4 WHERE id = ?5 AND revision = ?6",
        params![
            input.target_parent_board_id,
            dest_x,
            dest_y,
            now,
            portal_card_id,
            input.expected_portal_revision
        ],
    )?;
    if portal_changed == 0 {
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_portal_revision,
            actual: portal_revision,
        });
    }

    tx.commit()?;
    Ok(())
}

/// Returns a free placement slot on a board: the left column x, cascaded below
/// the lowest existing active card. Simple and deterministic so repeatedly
/// dropping Boards never stacks them invisibly at the same origin.
fn next_free_position(conn: &Connection, board_id: &str) -> (f64, f64) {
    const X: f64 = 40.0;
    const GAP: f64 = 24.0;

    let max_bottom: f64 = conn
        .query_row(
            "SELECT COALESCE(MAX(y + height), 0.0) FROM cards WHERE board_id = ?1 AND deleted_at IS NULL",
            [board_id],
            |r| r.get(0),
        )
        .unwrap_or(0.0);

    if max_bottom <= 0.0 {
        return (X, 40.0);
    }
    (X, max_bottom + GAP)
}

/// Sets a Board's cover image (a managed asset id). The cover replaces the
/// color/symbol tile; `None` removes it and returns to the fallback. The asset
/// must exist; board revision is deliberately not bumped (cover is cosmetic and
/// does not participate in move/rename optimistic concurrency).
pub fn set_board_cover(
    conn: &mut Connection,
    board_id: &str,
    asset_id: Option<&str>,
) -> Result<(), WorkspaceError> {
    let changed = match asset_id {
        Some(asset_id) => {
            let asset_exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM assets WHERE id = ?1",
                [asset_id],
                |r| r.get(0),
            )?;
            if asset_exists == 0 {
                return Err(WorkspaceError::NotFound(asset_id.to_string()));
            }
            conn.execute(
                "UPDATE boards SET cover_asset_id = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
                params![asset_id, db::migrations::now_millis(), board_id],
            )?
        }
        None => conn.execute(
            "UPDATE boards SET cover_asset_id = NULL, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![db::migrations::now_millis(), board_id],
        )?,
    };

    if changed == 0 {
        return Err(WorkspaceError::NotFound(board_id.to_string()));
    }
    Ok(())
}
