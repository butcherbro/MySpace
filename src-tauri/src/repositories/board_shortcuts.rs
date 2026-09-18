//! Board shortcut aggregate (todo.md №17): create + project a `board_shortcut`
//! card. Identity is read live through a JOIN on the target board — never
//! copied — and the JOIN is LEFT so a shortcut whose target is gone or trashed
//! (old data, or a cascade race) projects as "broken" (`target: None`) instead
//! of failing the whole board snapshot read.

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{
    AssetDto, BoardShortcutDto, BoardShortcutTarget, CardDto, CreateBoardShortcutInput, Frame,
};

use super::super::db;

/// One row of the board-shortcut projection, shared by the board-snapshot list
/// read and the single-card read.
pub(super) const SHORTCUT_SELECT_COLUMNS: &str =
    "c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
     s.target_board_id, b.id, b.revision, b.title, b.color_token, b.symbol, b.deleted_at,
     ca.id, ca.file_name, ca.mime_type, ca.width, ca.height, ca.size_bytes, ca.file_path";

pub(super) fn row_to_shortcut(row: &rusqlite::Row<'_>) -> rusqlite::Result<CardDto> {
    let target_board_id: String = row.get(8)?;
    let board_alive: Option<String> = row.get(9)?;
    let board_deleted_at: Option<i64> = row.get(14)?;
    let target = if board_alive.is_some() && board_deleted_at.is_none() {
        let cover_asset = if row.get::<_, Option<String>>(15)?.is_some() {
            Some(AssetDto {
                id: row.get(15)?,
                file_name: row.get(16)?,
                mime_type: row.get(17)?,
                width: row.get(18)?,
                height: row.get(19)?,
                size_bytes: row.get(20)?,
                file_path: row.get(21)?,
            })
        } else {
            None
        };
        Some(BoardShortcutTarget {
            id: target_board_id.clone(),
            board_revision: row.get(10)?,
            title: row.get(11)?,
            color_token: row.get(12)?,
            symbol: row.get(13)?,
            cover_asset,
        })
    } else {
        None
    };
    Ok(CardDto::BoardShortcut(BoardShortcutDto {
        id: row.get(0)?,
        board_id: row.get(1)?,
        frame: Frame {
            x: row.get(2)?,
            y: row.get(3)?,
            width: row.get(4)?,
            height: row.get(5)?,
        },
        z_index: row.get(6)?,
        revision: row.get(7)?,
        target_board_id,
        target,
    }))
}

/// Loads active board-shortcut cards of a board (canvas or Unsorted).
pub(super) fn load_board_shortcuts(
    conn: &Connection,
    board_id: &str,
    unsorted_flag: i64,
) -> Result<Vec<CardDto>, WorkspaceError> {
    let sql = format!(
        "SELECT {SHORTCUT_SELECT_COLUMNS}
         FROM cards c
         JOIN board_shortcut_cards s ON s.card_id = c.id
         LEFT JOIN boards b ON b.id = s.target_board_id
         LEFT JOIN assets ca ON ca.id = b.cover_asset_id
         WHERE c.board_id = ?1 AND c.deleted_at IS NULL AND c.unsorted = ?2
         ORDER BY c.z_index, c.id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut out = Vec::new();
    for row in stmt.query_map(params![board_id, unsorted_flag], row_to_shortcut)? {
        out.push(row?);
    }
    Ok(out)
}

/// Loads a single active board-shortcut card by id.
pub(super) fn load_board_shortcut_card(
    conn: &Connection,
    card_id: &str,
) -> Result<CardDto, WorkspaceError> {
    let sql = format!(
        "SELECT {SHORTCUT_SELECT_COLUMNS}
         FROM cards c
         JOIN board_shortcut_cards s ON s.card_id = c.id
         LEFT JOIN boards b ON b.id = s.target_board_id
         LEFT JOIN assets ca ON ca.id = b.cover_asset_id
         WHERE c.id = ?1 AND c.deleted_at IS NULL"
    );
    conn.query_row(&sql, [card_id], row_to_shortcut)
        .map_err(WorkspaceError::from)
}

/// Creates a board shortcut card (todo.md №17). The target board must exist
/// and not be trashed — a shortcut is never created pointing at nothing, even
/// though a *later* trash of the target is allowed to make an existing
/// shortcut broken (see `trash_service`).
pub fn create_board_shortcut(
    conn: &mut Connection,
    input: &CreateBoardShortcutInput,
) -> Result<CardDto, WorkspaceError> {
    let now = db::migrations::now_millis();

    let target_exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
        [input.target_board_id.as_str()],
        |r| r.get(0),
    )?;
    if target_exists == 0 {
        return Err(WorkspaceError::NotFound(input.target_board_id.clone()));
    }

    // Idempotent replay: the same card id already exists as a shortcut.
    let existing_kind: Option<String> = conn
        .query_row(
            "SELECT kind FROM cards WHERE id = ?1",
            [input.id.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(kind) = existing_kind {
        if kind == "board_shortcut" {
            return load_board_shortcut_card(conn, &input.id);
        }
        return Err(WorkspaceError::ConstraintViolation(format!(
            "card {} already exists with a different kind",
            input.id
        )));
    }

    let tx = conn.transaction()?;
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
