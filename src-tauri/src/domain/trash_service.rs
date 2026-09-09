//! Domain service for soft-delete (Trash) and batch restore.
//!
//! Deletion assigns `trash_batch_id` + `deleted_at` instead of removing rows
//! (ADR-006 / Section C invariant 8-10). A child-board subtree is collected with
//! a recursive CTE and trashed atomically; restore reverses a whole batch with
//! original placement preserved.

use rusqlite::{params, Connection, Transaction};

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{
    AssetDto, EmptyTrashResult, TrashBatchDto, TrashEntryDto, TrashSelectionInput, TrashSummaryDto,
};

use super::super::db;

/// Trashes a leaf card (note, image, embed, or filesystem alias) — soft-delete of its `cards`
/// row. Returns the batch id used for restore.
pub fn trash_note(conn: &mut Connection, card_id: &str) -> Result<String, WorkspaceError> {
    let now = db::migrations::now_millis();
    let batch_id = uuid::Uuid::now_v7().to_string();
    let changed = conn.execute(
        "UPDATE cards SET deleted_at = ?1, trash_batch_id = ?2, updated_at = ?1
         WHERE id = ?3 AND kind IN ('note', 'image', 'embed', 'filesystem_alias') AND deleted_at IS NULL",
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
                // leaf card: note / image / embed / filesystem alias
                let changed = tx.execute(
                    "UPDATE cards SET deleted_at = ?1, trash_batch_id = ?2, updated_at = ?1
                     WHERE id = ?3 AND kind IN ('note', 'image', 'embed', 'filesystem_alias') AND deleted_at IS NULL",
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

/// Permanently deletes every trashed row. This is the irreversible counterpart
/// to `restore_trash_batch`: trashed detail rows, cards, view states, quick-board
/// references, and boards are removed in one transaction (deferring FK checks so
/// a board subtree can be deleted regardless of internal child/parent order).
///
/// Returns relational counts only; asset cleanup is a separate mark-and-sweep
/// step (asset GC) that must run after this and after any backup gate.
pub fn empty_trash(
    conn: &mut Connection,
    confirmation: &str,
) -> Result<EmptyTrashResult, WorkspaceError> {
    if confirmation != "EMPTY" {
        return Err(WorkspaceError::ConstraintViolation(
            "type EMPTY to confirm".to_string(),
        ));
    }

    // Never repair a broken root invariant inside a destructive command: if the
    // root board is somehow trashed, refuse to empty.
    let root_trashed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM boards b
         JOIN workspaces w ON w.root_board_id = b.id
         WHERE b.deleted_at IS NOT NULL",
        [],
        |r| r.get(0),
    )?;
    if root_trashed > 0 {
        return Err(WorkspaceError::RootBoardProtected);
    }

    let board_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM boards WHERE deleted_at IS NOT NULL",
        [],
        |r| r.get(0),
    )?;
    let card_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM cards WHERE deleted_at IS NOT NULL",
        [],
        |r| r.get(0),
    )?;

    let tx = conn.transaction()?;
    tx.execute_batch("PRAGMA defer_foreign_keys = ON;")?;

    // Detail rows for trashed cards, leaves -> roots.
    tx.execute(
        "DELETE FROM note_cards WHERE card_id IN (SELECT id FROM cards WHERE deleted_at IS NOT NULL)",
        [],
    )?;
    tx.execute(
        "DELETE FROM image_cards WHERE card_id IN (SELECT id FROM cards WHERE deleted_at IS NOT NULL)",
        [],
    )?;
    tx.execute(
        "DELETE FROM embed_cards WHERE card_id IN (SELECT id FROM cards WHERE deleted_at IS NOT NULL)",
        [],
    )?;
    tx.execute(
        "DELETE FROM filesystem_aliases WHERE card_id IN (SELECT id FROM cards WHERE deleted_at IS NOT NULL)",
        [],
    )?;
    tx.execute(
        "DELETE FROM board_portal_cards WHERE card_id IN (SELECT id FROM cards WHERE deleted_at IS NOT NULL)",
        [],
    )?;
    // Board-referencing rows for trashed boards.
    tx.execute(
        "DELETE FROM board_view_states WHERE board_id IN (SELECT id FROM boards WHERE deleted_at IS NOT NULL)",
        [],
    )?;
    tx.execute(
        "DELETE FROM quick_boards WHERE board_id IN (SELECT id FROM boards WHERE deleted_at IS NOT NULL)",
        [],
    )?;

    tx.execute("DELETE FROM cards WHERE deleted_at IS NOT NULL", [])?;
    tx.execute("DELETE FROM boards WHERE deleted_at IS NOT NULL", [])?;
    tx.commit()?;

    Ok(EmptyTrashResult {
        board_count,
        card_count,
        orphan_asset_count: 0,
    })
}

/// Maximum Unicode scalar values for a Trash entry excerpt.
const EXCERPT_LIMIT: usize = 120;
/// Maximum number of batches returned by the V1 read model.
const MAX_BATCHES: usize = 100;

struct TrashedBoard {
    id: String,
    parent_board_id: Option<String>,
    title: String,
    batch_id: String,
    deleted_at: i64,
    color_token: String,
    symbol: Option<String>,
    cover_asset: Option<AssetDto>,
}

struct TrashedCard {
    id: String,
    board_id: String,
    kind: String,
    batch_id: String,
    deleted_at: i64,
    is_portal: bool,
    title: String,
    thumbnail_asset: Option<AssetDto>,
}

fn bound_excerpt(text: &str) -> String {
    text.trim().chars().take(EXCERPT_LIMIT).collect()
}

/// Builds the recoverable Trash read model without mutating the workspace.
/// Batches are ordered newest first; within a batch only directly-trashed
/// top-level Boards and leaf cards are listed as representative items, while
/// descendants and the primary portal are summarized in the counts.
pub fn list_trash(conn: &Connection) -> Result<TrashSummaryDto, WorkspaceError> {
    let mut boards = Vec::<TrashedBoard>::new();
    {
        let mut stmt = conn.prepare(
            "SELECT b.id, b.parent_board_id, b.title, b.trash_batch_id, b.deleted_at,
                    b.color_token, b.symbol,
                    ca.id, ca.file_name, ca.mime_type, ca.width, ca.height, ca.size_bytes, ca.file_path
             FROM boards b
             LEFT JOIN assets ca ON ca.id = b.cover_asset_id
             WHERE b.deleted_at IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            let cover_asset = if row.get::<_, Option<String>>(7)?.is_some() {
                Some(AssetDto {
                    id: row.get(7)?,
                    file_name: row.get(8)?,
                    mime_type: row.get(9)?,
                    width: row.get(10)?,
                    height: row.get(11)?,
                    size_bytes: row.get(12)?,
                    file_path: row.get(13)?,
                })
            } else {
                None
            };
            Ok(TrashedBoard {
                id: row.get(0)?,
                parent_board_id: row.get(1)?,
                title: row.get(2)?,
                batch_id: row.get(3)?,
                deleted_at: row.get(4)?,
                color_token: row.get(5)?,
                symbol: row.get(6)?,
                cover_asset,
            })
        })?;
        for row in rows {
            boards.push(row?);
        }
    }

    let mut cards = Vec::<TrashedCard>::new();
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, c.kind, c.trash_batch_id, c.deleted_at,
                    n.plain_text,
                    i.caption_plain_text, i.asset_id,
                    ia.file_name, ia.mime_type, ia.width, ia.height, ia.size_bytes, ia.file_path,
                    e.title, e.source_url, e.asset_id, e.favicon_asset_id,
                    pa.file_name, pa.mime_type, pa.width, pa.height, pa.size_bytes, pa.file_path,
                    fa.file_name, fa.mime_type, fa.width, fa.height, fa.size_bytes, fa.file_path,
                    fsa.display_name
             FROM cards c
             LEFT JOIN note_cards n ON n.card_id = c.id
             LEFT JOIN image_cards i ON i.card_id = c.id
             LEFT JOIN assets ia ON ia.id = i.asset_id
             LEFT JOIN embed_cards e ON e.card_id = c.id
             LEFT JOIN filesystem_aliases fsa ON fsa.card_id = c.id
             LEFT JOIN assets pa ON pa.id = e.asset_id
             LEFT JOIN assets fa ON fa.id = e.favicon_asset_id
             WHERE c.deleted_at IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            let kind: String = row.get(2)?;
            let is_portal = kind == "board_portal";
            let title = if is_portal {
                String::new()
            } else {
                let note_plain: Option<String> = row.get(5)?;
                let image_caption: Option<String> = row.get(6)?;
                let embed_title: Option<String> = row.get(13)?;
                let embed_source: Option<String> = row.get(14)?;
                let raw = match kind.as_str() {
                    "note" => note_plain.unwrap_or_default(),
                    "image" => {
                        let image_file: Option<String> = row.get(9)?;
                        image_caption
                            .filter(|s| !s.trim().is_empty())
                            .or_else(|| image_file)
                            .unwrap_or_default()
                    }
                    "embed" => embed_title
                        .filter(|s| !s.trim().is_empty())
                        .or_else(|| embed_source)
                        .unwrap_or_default(),
                    "filesystem_alias" => row.get::<_, Option<String>>(30)?.unwrap_or_default(),
                    _ => String::new(),
                };
                bound_excerpt(&raw)
            };

            let thumbnail_asset = match kind.as_str() {
                "image" => {
                    if row.get::<_, Option<String>>(7)?.is_some() {
                        Some(AssetDto {
                            id: row.get(7)?,
                            file_name: row.get(8)?,
                            mime_type: row.get(9)?,
                            width: row.get(10)?,
                            height: row.get(11)?,
                            size_bytes: row.get(12)?,
                            file_path: row.get(13)?,
                        })
                    } else {
                        None
                    }
                }
                "embed" => {
                    // Prefer the preview image, then the favicon.
                    if row.get::<_, Option<String>>(15)?.is_some() {
                        Some(AssetDto {
                            id: row.get(15)?,
                            file_name: row.get(16)?,
                            mime_type: row.get(17)?,
                            width: row.get(18)?,
                            height: row.get(19)?,
                            size_bytes: row.get(20)?,
                            file_path: row.get(21)?,
                        })
                    } else if row.get::<_, Option<String>>(22)?.is_some() {
                        Some(AssetDto {
                            id: row.get(22)?,
                            file_name: row.get(23)?,
                            mime_type: row.get(24)?,
                            width: row.get(25)?,
                            height: row.get(26)?,
                            size_bytes: row.get(27)?,
                            file_path: row.get(28)?,
                        })
                    } else {
                        None
                    }
                }
                _ => None,
            };

            Ok(TrashedCard {
                id: row.get(0)?,
                board_id: row.get(1)?,
                kind,
                batch_id: row.get(3)?,
                deleted_at: row.get(4)?,
                is_portal,
                title,
                thumbnail_asset,
            })
        })?;
        for row in rows {
            cards.push(row?);
        }
    }

    // Group rows by batch id preserving insertion order for a stable final sort.
    let mut batch_ids: Vec<String> = Vec::new();
    {
        let mut seen = std::collections::HashSet::new();
        // Deterministic order: collect board batch ids in query order, then any
        // card-only batch ids.
        for b in &boards {
            if seen.insert(b.batch_id.clone()) {
                batch_ids.push(b.batch_id.clone());
            }
        }
        for c in &cards {
            if seen.insert(c.batch_id.clone()) {
                batch_ids.push(c.batch_id.clone());
            }
        }
    }

    let mut batches = Vec::<TrashBatchDto>::new();
    for batch_id in &batch_ids {
        let boards_in_batch: Vec<&TrashedBoard> =
            boards.iter().filter(|b| &b.batch_id == batch_id).collect();
        let cards_in_batch: Vec<&TrashedCard> =
            cards.iter().filter(|c| &c.batch_id == batch_id).collect();

        let deleted_at = boards_in_batch
            .iter()
            .map(|b| b.deleted_at)
            .chain(cards_in_batch.iter().map(|c| c.deleted_at))
            .max()
            .unwrap_or(0);

        let board_id_set: std::collections::HashSet<&str> =
            boards_in_batch.iter().map(|b| b.id.as_str()).collect();

        // A Board is top-level when its parent is not part of the same batch.
        let mut board_items: Vec<TrashEntryDto> = boards_in_batch
            .iter()
            .filter(|b| {
                b.parent_board_id
                    .as_deref()
                    .map(|p| !board_id_set.contains(p))
                    .unwrap_or(true)
            })
            .map(|b| TrashEntryDto {
                id: b.id.clone(),
                kind: "board".to_string(),
                title: bound_excerpt(&b.title),
                thumbnail_asset: b.cover_asset.clone(),
                color_token: Some(b.color_token.clone()),
                symbol: b.symbol.clone(),
            })
            .collect();
        board_items.sort_by(|a, b| a.title.cmp(&b.title).then_with(|| a.id.cmp(&b.id)));

        // A leaf card is top-level when its owning Board is not trashed in the
        // same batch. Portals are never listed (a trashed Board already
        // represents its primary portal).
        let mut card_items: Vec<TrashEntryDto> = cards_in_batch
            .iter()
            .filter(|c| !c.is_portal && !board_id_set.contains(c.board_id.as_str()))
            .map(|c| TrashEntryDto {
                id: c.id.clone(),
                kind: c.kind.clone(),
                title: c.title.clone(),
                thumbnail_asset: c.thumbnail_asset.clone(),
                color_token: None,
                symbol: None,
            })
            .collect();
        card_items.sort_by(|a, b| a.title.cmp(&b.title).then_with(|| a.id.cmp(&b.id)));

        let mut items = Vec::with_capacity(board_items.len() + card_items.len());
        items.extend(board_items);
        items.extend(card_items);

        batches.push(TrashBatchDto {
            batch_id: batch_id.clone(),
            deleted_at,
            items,
            board_count: boards_in_batch.len() as i64,
            card_count: cards_in_batch.len() as i64,
        });
    }

    batches.truncate(MAX_BATCHES);
    batches.sort_by(|a, b| {
        b.deleted_at
            .cmp(&a.deleted_at)
            .then_with(|| b.batch_id.cmp(&a.batch_id))
    });

    let batch_count = batches.len() as i64;
    let board_count = batches.iter().map(|b| b.board_count).sum();
    let card_count = batches.iter().map(|b| b.card_count).sum();

    Ok(TrashSummaryDto {
        batches,
        batch_count,
        board_count,
        card_count,
    })
}
