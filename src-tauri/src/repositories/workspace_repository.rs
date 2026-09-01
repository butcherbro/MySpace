//! Repository for reading board snapshots and creating notes.
//!
//! SQLite is authoritative (ADR-003). These functions are the only place that
//! maps database rows to domain DTOs and back.

use rusqlite::{params, Connection};

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{
    BoardPortalDto, BoardSnapshot, BoardSummary, Breadcrumb, CardDto, CreateNoteInput, Frame,
    NoteCardDto, PortalTarget, UpdateCardFrameInput, UpdateNoteInput, Viewport,
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
    // A view state row is expected to exist for every board. Fall back to
    // origin defaults defensively if it does not.
    let result = conn.query_row(
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
    );

    match result {
        Ok(v) => Ok(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(Viewport {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
            revision: 1,
        }),
        Err(e) => Err(WorkspaceError::from(e)),
    }
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

    // Board portals
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
                    p.target_board_id, b.title, b.color_token, b.symbol
             FROM cards c
             JOIN board_portal_cards p ON p.card_id = c.id
             JOIN boards b ON b.id = p.target_board_id
             WHERE c.board_id = ?1 AND c.deleted_at IS NULL
             ORDER BY c.z_index, c.id",
        )?;
        let rows = stmt.query_map([board_id], |row| {
            let target_id: String = row.get(8)?;
            let (child_board_count, child_card_count) = if include_subtree_counts {
                (
                    count_child_boards(conn, &target_id)?,
                    count_child_cards(conn, &target_id)?,
                )
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

    Ok(out)
}

fn count_child_boards(conn: &Connection, board_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM boards WHERE parent_board_id = ?1 AND deleted_at IS NULL",
        [board_id],
        |r| r.get(0),
    )
}

fn count_child_cards(conn: &Connection, board_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM cards WHERE board_id = ?1 AND deleted_at IS NULL",
        [board_id],
        |r| r.get(0),
    )
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
