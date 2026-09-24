//! Board shortcut aggregate (todo.md №17): create + project a `board_shortcut`
//! card. Identity is read live through a JOIN on the target board — never
//! copied — and the JOIN is LEFT so a shortcut whose target is gone or trashed
//! (old data, or a cascade race) projects as "broken" (`target: None`) instead
//! of failing the whole board snapshot read.

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::card_kind::{handler, CardKind};
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{CardDto, CreateBoardShortcutInput};

use super::super::db;
use super::immediate_tx;

/// Loads a single active board-shortcut card by id (the projection lives in
/// `domain::kinds::board_shortcut`).
fn load_board_shortcut_card(conn: &Connection, card_id: &str) -> Result<CardDto, WorkspaceError> {
    handler(CardKind::BoardShortcut)
        .load_one(conn, card_id)?
        .ok_or_else(|| WorkspaceError::NotFound(card_id.to_string()))
}

/// Creates a board shortcut card (todo.md №17). The target board must exist
/// and not be trashed — a shortcut is never created pointing at nothing, even
/// though a *later* trash of the target is allowed to make an existing
/// shortcut broken (see `trash_service`).
pub fn create_board_shortcut(
    conn: &mut Connection,
    input: &CreateBoardShortcutInput,
) -> Result<CardDto, WorkspaceError> {
    input.frame.validate()?;
    let now = db::migrations::now_millis();

    // BEGIN IMMEDIATE before the guards so the target check, the replay check
    // and the inserts are atomic against another writer process.
    let tx = immediate_tx(conn)?;

    let target_exists: i64 = tx.query_row(
        "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
        [input.target_board_id.as_str()],
        |r| r.get(0),
    )?;
    if target_exists == 0 {
        return Err(WorkspaceError::NotFound(input.target_board_id.clone()));
    }

    // Idempotent replay: the same card id already exists as a shortcut.
    let existing_kind: Option<String> = tx
        .query_row(
            "SELECT kind FROM cards WHERE id = ?1",
            [input.id.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(kind) = existing_kind {
        if kind == "board_shortcut" {
            return load_board_shortcut_card(&tx, &input.id);
        }
        return Err(WorkspaceError::ConstraintViolation(format!(
            "card {} already exists with a different kind",
            input.id
        )));
    }

    tx.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at)
         VALUES (?1, ?2, 'board_shortcut', ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)",
        params![
            input.id,
            input.board_id,
            input.frame.x,
            input.frame.y,
            input.frame.width,
            input.frame.height,
            input.z_index,
            now,
        ],
    )?;
    tx.execute(
        "INSERT INTO board_shortcut_cards (card_id, target_board_id) VALUES (?1, ?2)",
        params![input.id, input.target_board_id],
    )?;
    tx.commit()?;

    load_board_shortcut_card(conn, &input.id)
}
