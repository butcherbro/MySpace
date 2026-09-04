//! Domain service for soft-delete (Trash) and batch restore.
//!
//! Deletion assigns `trash_batch_id` + `deleted_at` instead of removing rows
//! (ADR-006 / Section C invariant 8-10). A child-board subtree is collected with
//! a recursive CTE and trashed atomically; restore reverses a whole batch with
//! original placement preserved.

use rusqlite::{params, Connection, Transaction};

use crate::domain::errors::WorkspaceError;
use crate::domain::models::TrashSelectionInput;

use super::super::db;

/// Trashes a leaf card (note, image, or embed) — soft-delete of its `cards`
/// row. Returns the batch id used for restore.
pub fn trash_note(conn: &mut Connection, card_id: &str) -> Result<String, WorkspaceError> {
    let now = db::migrations::now_millis();
    let batch_id = uuid::Uuid::now_v7().to_string();
    let changed = conn.execute(
        "UPDATE cards SET deleted_at = ?1, trash_batch_id = ?2, updated_at = ?1
         WHERE id = ?3 AND kind IN ('note', 'image', 'embed') AND deleted_at IS NULL",
        params![now, batch_id, card_id],
    )?;
    if changed == 0 {
        return Err(WorkspaceError::NotFound(card_id.to_string()));
    }
    Ok(batch_id)
}

/// Trashes a board and its complete descendant subtree, plus its primary portal
/// card, in one transaction. Returns the trash batch id. The root cannot be
/// trashed.
pub fn trash_board(conn: &mut Connection, board_id: &str) -> Result<String, WorkspaceError> {
    let is_root: i64 = conn.query_row(
        "SELECT COUNT(*) FROM workspaces WHERE root_board_id = ?1",
        [board_id],
        |r| r.get(0),
    )?;
    if is_root > 0 {
        return Err(WorkspaceError::RootBoardProtected);
    }

    let now = db::migrations::now_millis();
    let batch_id = uuid::Uuid::now_v7().to_string();

    let tx = conn.transaction()?;

    // Collect the board subtree (target + descendants) via recursive CTE.
    let collected: i64 = tx.query_row(
        "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
        [board_id],
        |r| r.get(0),
    )?;
    if collected == 0 {
        return Err(WorkspaceError::NotFound(board_id.to_string()));
    }

    // Mark all boards in the subtree.
    tx.execute(
        "WITH RECURSIVE subtree(id) AS (
            SELECT id FROM boards WHERE id = ?1
            UNION ALL
            SELECT b.id FROM boards b JOIN subtree s ON b.parent_board_id = s.id
         )
         UPDATE boards
         SET deleted_at = ?2, trash_batch_id = ?3
         WHERE id IN (SELECT id FROM subtree)",
        params![board_id, now, batch_id],
    )?;

    // Mark all cards belonging to those boards.
    tx.execute(
        "UPDATE cards
         SET deleted_at = ?2, trash_batch_id = ?3
         WHERE board_id IN (
            WITH RECURSIVE subtree(id) AS (
                SELECT id FROM boards WHERE id = ?1
                UNION ALL
                SELECT b.id FROM boards b JOIN subtree s ON b.parent_board_id = s.id
            )
            SELECT id FROM subtree
         )",
        params![board_id, now, batch_id],
    )?;

    // Mark the primary portal card (which lives on the parent board) that
    // targets this board.
    tx.execute(
        "UPDATE cards
         SET deleted_at = ?2, trash_batch_id = ?3
         WHERE id IN (SELECT card_id FROM board_portal_cards WHERE target_board_id = ?1)
           AND deleted_at IS NULL",
        params![board_id, now, batch_id],
    )?;

    tx.commit()?;
    Ok(batch_id)
}

/// Trashes a board's complete descendant subtree, plus its primary portal card,
/// inside an existing transaction. Assumes the board exists and is not trashed;
/// callers are responsible for those checks.
fn trash_board_in_tx(
    tx: &Transaction,
    board_id: &str,
    batch_id: &str,
    now: i64,
) -> Result<(), WorkspaceError> {
    tx.execute(
        "WITH RECURSIVE subtree(id) AS (
            SELECT id FROM boards WHERE id = ?1
            UNION ALL
            SELECT b.id FROM boards b JOIN subtree s ON b.parent_board_id = s.id
         )
         UPDATE boards
         SET deleted_at = ?2, trash_batch_id = ?3
         WHERE id IN (SELECT id FROM subtree)",
        params![board_id, now, batch_id],
    )?;

    tx.execute(
        "UPDATE cards
         SET deleted_at = ?2, trash_batch_id = ?3
         WHERE board_id IN (
            WITH RECURSIVE subtree(id) AS (
                SELECT id FROM boards WHERE id = ?1
                UNION ALL
                SELECT b.id FROM boards b JOIN subtree s ON b.parent_board_id = s.id
            )
            SELECT id FROM subtree
         )",
        params![board_id, now, batch_id],
    )?;

    tx.execute(
        "UPDATE cards
         SET deleted_at = ?2, trash_batch_id = ?3
         WHERE id IN (SELECT card_id FROM board_portal_cards WHERE target_board_id = ?1)
           AND deleted_at IS NULL",
        params![board_id, now, batch_id],
    )?;

    Ok(())
}

/// Atomically trashes a mixed selection (leaf cards + boards) in a single
/// transaction under one batch id. Any failure rolls the whole batch back, so a
/// partial trash can never occur.
pub fn trash_selection(
    conn: &mut Connection,
    input: &TrashSelectionInput,
) -> Result<String, WorkspaceError> {
    let now = db::migrations::now_millis();
    let batch_id = uuid::Uuid::now_v7().to_string();

    let tx = conn.transaction()?;

    for item in &input.items {
        match item.kind.as_str() {
            "board_portal" => {
                let is_root: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM workspaces WHERE root_board_id = ?1",
                    [item.id.as_str()],
                    |r| r.get(0),
                )?;
                if is_root > 0 {
                    return Err(WorkspaceError::RootBoardProtected);
                }
                let exists: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
                    [item.id.as_str()],
                    |r| r.get(0),
                )?;
                if exists == 0 {
                    return Err(WorkspaceError::NotFound(item.id.clone()));
                }
                trash_board_in_tx(&tx, &item.id, &batch_id, now)?;
            }
            _ => {
                // leaf card: note / image / embed
                let changed = tx.execute(
                    "UPDATE cards SET deleted_at = ?1, trash_batch_id = ?2, updated_at = ?1
                     WHERE id = ?3 AND kind IN ('note', 'image', 'embed') AND deleted_at IS NULL",
                    params![now, batch_id, item.id],
                )?;
                if changed == 0 {
                    return Err(WorkspaceError::NotFound(item.id.clone()));
                }
            }
        }
    }

    tx.commit()?;
    Ok(batch_id)
}

/// Restores a trash batch: clears `deleted_at`/`trash_batch_id` on all boards,
/// cards in the batch, restoring original placement.
pub fn restore_trash_batch(conn: &mut Connection, batch_id: &str) -> Result<(), WorkspaceError> {
    let tx = conn.transaction()?;

    tx.execute(
        "UPDATE boards SET deleted_at = NULL, trash_batch_id = NULL WHERE trash_batch_id = ?1",
        [batch_id],
    )?;
    tx.execute(
        "UPDATE cards SET deleted_at = NULL, trash_batch_id = NULL WHERE trash_batch_id = ?1",
        [batch_id],
    )?;

    tx.commit()?;
    Ok(())
}
