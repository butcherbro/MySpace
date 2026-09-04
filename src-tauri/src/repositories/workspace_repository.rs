//! Repository for reading board snapshots and creating notes.
//!
//! SQLite is authoritative (ADR-003). These functions are the only place that
//! maps database rows to domain DTOs and back.

use rusqlite::{params, Connection};

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{
    AssetDto, BoardPortalDto, BoardSnapshot, BoardSummary, Breadcrumb, CardDto,
    CreateImageCardInput, CreateNoteInput, Frame, ImageCardDto, MoveCardToBoardInput,
    MoveCardsInput, NoteCardDto, PortalTarget, UpdateCardFrameInput, UpdateImageCaptionInput,
    UpdateNoteInput, UpdateViewportInput, Viewport,
};

use super::super::db;

/// Loads the complete, self-contained projection of a board.
pub fn load_board_snapshot(
    conn: &Connection,
    board_id: &str,
) -> Result<BoardSnapshot, WorkspaceError> {
    let board = load_board_summary(conn, board_id)?;
    let breadcrumbs = load_breadcrumbs(conn, board_id)?;
    let viewport = load_viewport(conn, board_id)?;
    let cards = load_cards(conn, board_id, true)?;

    Ok(BoardSnapshot {
        board,
        breadcrumbs,
        viewport,
        cards,
    })
}

fn load_board_summary(conn: &Connection, board_id: &str) -> Result<BoardSummary, WorkspaceError> {
    conn.query_row(
        "SELECT id, title, parent_board_id, revision FROM boards WHERE id = ?1 AND deleted_at IS NULL",
        [board_id],
        |row| {
            Ok(BoardSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                parent_board_id: row.get(2)?,
                revision: row.get(3)?,
            })
        },
    )
    .map_err(WorkspaceError::from)
}

/// Collects the ancestor chain from Home down to `board_id`, inclusive.
fn load_breadcrumbs(conn: &Connection, board_id: &str) -> Result<Vec<Breadcrumb>, WorkspaceError> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE ancestors(id, title, parent_board_id, depth) AS (
            SELECT id, title, parent_board_id, 0 FROM boards WHERE id = ?1
            UNION ALL
            SELECT b.id, b.title, b.parent_board_id, a.depth - 1
            FROM boards b
            JOIN ancestors a ON b.id = a.parent_board_id
        )
        SELECT id, title FROM ancestors ORDER BY depth DESC",
    )?;

    let rows = stmt.query_map([board_id], |row| {
        Ok(Breadcrumb {
            id: row.get(0)?,
            title: row.get(1)?,
        })
    })?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn load_viewport(conn: &Connection, board_id: &str) -> Result<Viewport, WorkspaceError> {
    conn.query_row(
        "SELECT viewport_x, viewport_y, zoom, revision FROM board_view_states WHERE board_id = ?1",
        [board_id],
        |row| {
            Ok(Viewport {
                x: row.get(0)?,
                y: row.get(1)?,
                zoom: row.get(2)?,
                revision: row.get(3)?,
            })
        },
    )
    .map_err(WorkspaceError::from)
}

/// Loads active cards of a board. When `include_subtree_counts` is true, portal
/// targets carry child board/card counts.
fn load_cards(
    conn: &Connection,
    board_id: &str,
    include_subtree_counts: bool,
) -> Result<Vec<CardDto>, WorkspaceError> {
    let mut out = Vec::new();

    // Notes
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
                    n.document_json, n.plain_text
             FROM cards c
             JOIN note_cards n ON n.card_id = c.id
             WHERE c.board_id = ?1 AND c.deleted_at IS NULL
             ORDER BY c.z_index, c.id",
        )?;
        let rows = stmt.query_map([board_id], |row| {
            let document_json: String = row.get(8)?;
            let document_json: serde_json::Value =
                serde_json::from_str(&document_json).unwrap_or(serde_json::Value::Null);
            Ok(CardDto::Note(NoteCardDto {
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
                document_json,
                plain_text: row.get(9)?,
            }))
        })?;

        for r in rows {
            out.push(r?);
        }
    }

    // Board portals. Child counts are aggregated in one query per portal via
    // correlated subqueries, avoiding an N+1 pattern.
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
                    p.target_board_id, b.title, b.color_token, b.symbol,
                    COALESCE(child.child_board_count, 0),
                    COALESCE(cardchild.child_card_count, 0)
             FROM cards c
             JOIN board_portal_cards p ON p.card_id = c.id
             JOIN boards b ON b.id = p.target_board_id
             LEFT JOIN (
                 SELECT parent_board_id, COUNT(*) AS child_board_count
                 FROM boards WHERE deleted_at IS NULL GROUP BY parent_board_id
             ) child ON child.parent_board_id = p.target_board_id
             LEFT JOIN (
                 SELECT board_id, COUNT(*) AS child_card_count
                 FROM cards WHERE deleted_at IS NULL GROUP BY board_id
             ) cardchild ON cardchild.board_id = p.target_board_id
             WHERE c.board_id = ?1 AND c.deleted_at IS NULL
             ORDER BY c.z_index, c.id",
        )?;
        let rows = stmt.query_map([board_id], |row| {
            let target_id: String = row.get(8)?;
            let (child_board_count, child_card_count) = if include_subtree_counts {
                (row.get::<_, i64>(12)?, row.get::<_, i64>(13)?)
            } else {
                (0, 0)
            };
            Ok(CardDto::BoardPortal(BoardPortalDto {
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
                target: PortalTarget {
                    id: target_id,
                    title: row.get(9)?,
                    color_token: row.get(10)?,
                    symbol: row.get(11)?,
                    child_board_count,
                    child_card_count,
                },
            }))
        })?;

        for r in rows {
            out.push(r?);
        }
    }

    // Image cards: a static image plus an editable caption.
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
                    i.asset_id, a.file_name, a.mime_type, a.width, a.height, a.size_bytes, a.file_path,
                    i.caption_json, i.caption_plain_text
             FROM cards c
             JOIN image_cards i ON i.card_id = c.id
             JOIN assets a ON a.id = i.asset_id
             WHERE c.board_id = ?1 AND c.deleted_at IS NULL
             ORDER BY c.z_index, c.id",
        )?;
        let rows = stmt.query_map([board_id], |row| {
            let caption_json: String = row.get(15)?;
            let caption_json: serde_json::Value =
                serde_json::from_str(&caption_json).unwrap_or(serde_json::Value::Null);
            Ok(CardDto::Image(ImageCardDto {
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
                asset: AssetDto {
                    id: row.get(8)?,
                    file_name: row.get(9)?,
                    mime_type: row.get(10)?,
                    width: row.get(11)?,
                    height: row.get(12)?,
                    size_bytes: row.get(13)?,
                    file_path: row.get(14)?,
                },
                caption_json,
                caption_plain_text: row.get(16)?,
            }))
        })?;

        for r in rows {
            out.push(r?);
        }
    }

    Ok(out)
}

/// Creates a note card (and its `note_cards` row) in a single transaction.
///
/// A failed insert must leave no orphaned `cards` row: both inserts share one
/// transaction, so any failure rolls both back.
pub fn create_note(conn: &mut Connection, input: &CreateNoteInput) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();
    let document_json = serde_json::to_string(&input.document_json)
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;

    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at)
         VALUES (?1, ?2, 'note', ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9)",
        params![
            input.id,
            input.board_id,
            input.frame.x,
            input.frame.y,
            input.frame.width,
            input.frame.height,
            input.z_index,
            now,
            now,
        ],
    )?;
    tx.execute(
        "INSERT INTO note_cards (card_id, document_json, plain_text)
         VALUES (?1, ?2, ?3)",
        params![input.id, document_json, input.plain_text],
    )?;
    tx.commit()?;

    Ok(())
}

/// Updates a note's content, bumping its revision, guarded by an optimistic
/// `expected_revision`. A stale revision is rejected rather than silently
/// overwriting newer state (Section C invariant 11).
pub fn update_note(conn: &mut Connection, input: &UpdateNoteInput) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();
    let document_json = serde_json::to_string(&input.document_json)
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;

    let tx = conn.transaction()?;

    let changed = tx.execute(
        "UPDATE cards SET revision = revision + 1, updated_at = ?1
         WHERE id = ?2 AND revision = ?3",
        params![now, input.id, input.expected_revision],
    )?;

    if changed == 0 {
        let exists: i64 = tx.query_row(
            "SELECT COUNT(*) FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(WorkspaceError::NotFound(input.id.clone()));
        }
        let actual: i64 = tx.query_row(
            "SELECT revision FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_revision,
            actual,
        });
    }

    tx.execute(
        "UPDATE note_cards SET document_json = ?1, plain_text = ?2 WHERE card_id = ?3",
        params![document_json, input.plain_text, input.id],
    )?;

    tx.commit()?;
    Ok(())
}

/// Updates an image card's caption, bumping its revision with an optimistic
/// `expected_revision` guard (mirrors `update_note`).
pub fn update_image_caption(
    conn: &mut Connection,
    input: &UpdateImageCaptionInput,
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();
    let caption_json = serde_json::to_string(&input.caption_json)
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;

    let tx = conn.transaction()?;

    let changed = tx.execute(
        "UPDATE cards SET revision = revision + 1, updated_at = ?1
         WHERE id = ?2 AND revision = ?3 AND kind = 'image'",
        params![now, input.id, input.expected_revision],
    )?;

    if changed == 0 {
        let exists: i64 = tx.query_row(
            "SELECT COUNT(*) FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(WorkspaceError::NotFound(input.id.clone()));
        }
        let actual: i64 = tx.query_row(
            "SELECT revision FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_revision,
            actual,
        });
    }

    tx.execute(
        "UPDATE image_cards SET caption_json = ?1, caption_plain_text = ?2 WHERE card_id = ?3",
        params![caption_json, input.caption_plain_text, input.id],
    )?;

    tx.commit()?;
    Ok(())
}

/// Updates a card's frame (position and size), bumping its revision with an
/// optimistic `expected_revision` guard. Works for both notes and portals.
pub fn update_card_frame(
    conn: &mut Connection,
    input: &UpdateCardFrameInput,
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();

    let changed = conn.execute(
        "UPDATE cards
         SET x = ?1, y = ?2, width = ?3, height = ?4, revision = revision + 1, updated_at = ?5
         WHERE id = ?6 AND revision = ?7",
        params![
            input.frame.x,
            input.frame.y,
            input.frame.width,
            input.frame.height,
            now,
            input.id,
            input.expected_revision,
        ],
    )?;

    if changed == 0 {
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(WorkspaceError::NotFound(input.id.clone()));
        }
        let actual: i64 = conn.query_row(
            "SELECT revision FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_revision,
            actual,
        });
    }

    Ok(())
}

/// Persists a board's viewport, bumping its revision with an optimistic guard.
pub fn update_viewport(
    conn: &mut Connection,
    input: &UpdateViewportInput,
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();

    let changed = conn.execute(
        "UPDATE board_view_states
         SET viewport_x = ?1, viewport_y = ?2, zoom = ?3, revision = revision + 1, updated_at = ?4
         WHERE board_id = ?5 AND revision = ?6",
        params![
            input.x,
            input.y,
            input.zoom,
            now,
            input.board_id,
            input.expected_revision,
        ],
    )?;

    if changed == 0 {
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM board_view_states WHERE board_id = ?1",
            [input.board_id.clone()],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(WorkspaceError::NotFound(input.board_id.clone()));
        }
        let actual: i64 = conn.query_row(
            "SELECT revision FROM board_view_states WHERE board_id = ?1",
            [input.board_id.clone()],
            |r| r.get(0),
        )?;
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_revision,
            actual,
        });
    }

    Ok(())
}

/// Moves multiple cards atomically (one gesture = one transaction). Every card
/// must match its expected revision, or the whole batch is rejected and rolled
/// back.
pub fn move_cards(conn: &mut Connection, input: &MoveCardsInput) -> Result<(), WorkspaceError> {
    let tx = conn.transaction()?;

    for item in &input.cards {
        let changed = tx.execute(
            "UPDATE cards
             SET x = ?1, y = ?2, width = ?3, height = ?4, revision = revision + 1, updated_at = ?5
             WHERE id = ?6 AND revision = ?7",
            params![
                item.frame.x,
                item.frame.y,
                item.frame.width,
                item.frame.height,
                db::migrations::now_millis(),
                item.id,
                item.expected_revision,
            ],
        )?;

        if changed == 0 {
            let exists: i64 = tx.query_row(
                "SELECT COUNT(*) FROM cards WHERE id = ?1",
                [item.id.clone()],
                |r| r.get(0),
            )?;
            if exists == 0 {
                return Err(WorkspaceError::NotFound(item.id.clone()));
            }
            let actual: i64 = tx.query_row(
                "SELECT revision FROM cards WHERE id = ?1",
                [item.id.clone()],
                |r| r.get(0),
            )?;
            return Err(WorkspaceError::StaleRevision {
                expected: item.expected_revision,
                actual,
            });
        }
    }

    tx.commit()?;
    Ok(())
}

/// Creates an image card referencing an already-imported asset, in one
/// transaction (cards row + image_cards row). A failed detail insert leaves no
/// orphaned `cards` row.
pub fn create_image_card(
    conn: &mut Connection,
    input: &CreateImageCardInput,
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();
    let caption_json = serde_json::to_string(&input.caption_json)
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;

    // The referenced asset must exist.
    let asset_exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM assets WHERE id = ?1",
        [input.asset_id.as_str()],
        |r| r.get(0),
    )?;
    if asset_exists == 0 {
        return Err(WorkspaceError::NotFound(input.asset_id.clone()));
    }

    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at)
         VALUES (?1, ?2, 'image', ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)",
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
        "INSERT INTO image_cards (card_id, asset_id, caption_json, caption_plain_text)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            input.id,
            input.asset_id,
            caption_json,
            input.caption_plain_text,
        ],
    )?;
    tx.commit()?;

    Ok(())
}

/// Moves a leaf card (note/image/embed) to a different board, resetting its
/// position to the target board's origin and bumping its revision with an
/// optimistic `expected_revision` guard. Used to drop a card onto a board portal.
pub fn move_card_to_board(
    conn: &mut Connection,
    input: &MoveCardToBoardInput,
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();

    // The target board must exist and not be trashed.
    let target_exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
        [input.target_board_id.as_str()],
        |r| r.get(0),
    )?;
    if target_exists == 0 {
        return Err(WorkspaceError::NotFound(input.target_board_id.clone()));
    }

    let tx = conn.transaction()?;

    let changed = tx.execute(
        "UPDATE cards
         SET board_id = ?1, x = 40, y = 40, revision = revision + 1, updated_at = ?2
         WHERE id = ?3 AND revision = ?4 AND kind IN ('note', 'image', 'embed')",
        params![
            input.target_board_id,
            now,
            input.id,
            input.expected_revision
        ],
    )?;

    if changed == 0 {
        let exists: i64 = tx.query_row(
            "SELECT COUNT(*) FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(WorkspaceError::NotFound(input.id.clone()));
        }
        let actual: i64 = tx.query_row(
            "SELECT revision FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_revision,
            actual,
        });
    }

    tx.commit()?;
    Ok(())
}
