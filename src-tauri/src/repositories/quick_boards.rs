//! Quick Boards: the persistent references the rail shows (ADR-0005 entity
//! addressing). Split out of `workspace_repository` without changing any SQL.

use rusqlite::{params, Connection};

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{AddQuickBoardInput, AssetDto, QuickBoardDto, ReorderQuickBoardsInput};

use super::super::db;
use super::immediate_tx;

// --- Quick Boards (persistent references, ADR-0005 entity addressing) ---

/// Lists Quick Boards in persisted order. Only references to active Boards are
/// returned (a trashed/missing Board never renders as a live Quick Board).
pub fn list_quick_boards(conn: &Connection) -> Result<Vec<QuickBoardDto>, WorkspaceError> {
    let mut stmt = conn.prepare(
        "SELECT qb.board_id, b.title, b.color_token, b.symbol, qb.sort_order,
                ca.id, ca.file_name, ca.mime_type, ca.width, ca.height, ca.size_bytes, ca.file_path
         FROM quick_boards qb
         JOIN boards b ON b.id = qb.board_id
         LEFT JOIN assets ca ON ca.id = b.cover_asset_id
         WHERE b.deleted_at IS NULL
         ORDER BY qb.sort_order ASC, qb.board_id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        let cover_asset = if row.get::<_, Option<String>>(5)?.is_some() {
            Some(AssetDto {
                id: row.get(5)?,
                file_name: row.get(6)?,
                mime_type: row.get(7)?,
                width: row.get(8)?,
                height: row.get(9)?,
                size_bytes: row.get(10)?,
                file_path: row.get(11)?,
            })
        } else {
            None
        };
        Ok(QuickBoardDto {
            board_id: row.get(0)?,
            title: row.get(1)?,
            color_token: row.get(2)?,
            symbol: row.get(3)?,
            sort_order: row.get(4)?,
            cover_asset,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Adds a Quick Board reference idempotently. The target Board must be active
/// and non-Home; re-adding an already-pinned Board is a no-op (succeeds).
pub fn add_quick_board(
    conn: &mut Connection,
    input: &AddQuickBoardInput,
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();

    // BEGIN IMMEDIATE before the guards so the root/active/pinned checks, the
    // next sort order and the insert are atomic against another writer.
    let tx = immediate_tx(conn)?;

    let is_root: i64 = tx.query_row(
        "SELECT COUNT(*) FROM workspaces WHERE root_board_id = ?1",
        [input.board_id.as_str()],
        |r| r.get(0),
    )?;
    if is_root > 0 {
        return Err(WorkspaceError::RootBoardProtected);
    }

    let active: i64 = tx.query_row(
        "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
        [input.board_id.as_str()],
        |r| r.get(0),
    )?;
    if active == 0 {
        return Err(WorkspaceError::NotFound(input.board_id.clone()));
    }

    // Idempotent: already pinned -> no-op.
    let pinned: i64 = tx.query_row(
        "SELECT COUNT(*) FROM quick_boards WHERE board_id = ?1",
        [input.board_id.as_str()],
        |r| r.get(0),
    )?;
    if pinned > 0 {
        return Ok(());
    }

    let next: i64 = tx.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM quick_boards",
        [],
        |r| r.get(0),
    )?;

    tx.execute(
        "INSERT INTO quick_boards (board_id, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)",
        params![input.board_id, next, now],
    )?;
    tx.commit()?;
    Ok(())
}

/// Removes a Quick Board reference. Removing an unpinned Board is a no-op.
pub fn remove_quick_board(conn: &mut Connection, board_id: &str) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();
    // BEGIN IMMEDIATE before reading the position so the renumbering uses the
    // position that is actually deleted.
    let tx = immediate_tx(conn)?;
    // Delete the reference; renumber subsequent positions so the order stays dense.
    let removed = tx
        .prepare("SELECT sort_order FROM quick_boards WHERE board_id = ?1")
        .and_then(|mut stmt| {
            let mut rows = stmt.query([board_id])?;
            if let Some(row) = rows.next()? {
                Ok(row.get::<_, i64>(0)?)
            } else {
                Ok(-1)
            }
        })?;
    if removed < 0 {
        return Ok(()); // no-op
    }

    tx.execute("DELETE FROM quick_boards WHERE board_id = ?1", [board_id])?;
    tx.execute(
        "UPDATE quick_boards SET sort_order = sort_order - 1, updated_at = ?1 WHERE sort_order > ?2",
        params![now, removed],
    )?;
    tx.commit()?;
    Ok(())
}

/// must contain exactly the currently-pinned Board ids (no missing/extra ids),
/// otherwise the operation is rejected without partial writes.
pub fn reorder_quick_boards(
    conn: &mut Connection,
    input: &ReorderQuickBoardsInput,
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();
    let tx = immediate_tx(conn)?;

    let current_count: i64 = tx.query_row("SELECT COUNT(*) FROM quick_boards", [], |r| r.get(0))?;
    if current_count as usize != input.board_ids.len() {
        return Err(WorkspaceError::ConstraintViolation(
            "reorder must include every pinned board exactly once".to_string(),
        ));
    }

    for (i, board_id) in input.board_ids.iter().enumerate() {
        let changed = tx.execute(
            "UPDATE quick_boards SET sort_order = ?1, updated_at = ?2 WHERE board_id = ?3",
            params![i as i64, now, board_id],
        )?;
        if changed == 0 {
            return Err(WorkspaceError::NotFound(board_id.clone()));
        }
    }

    tx.commit()?;
    Ok(())
}
