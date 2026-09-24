//! Board aggregate: the board snapshot the UI renders, the board list, and the
//! breadcrumb trail and viewport that belong to a board. Split out of
//! `workspace_repository` without changing any SQL.

use rusqlite::{params, Connection};

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{
    AssetDto, BoardSnapshot, BoardSummary, Breadcrumb, UpdateViewportInput, Viewport,
};

use super::super::db;
use super::cards::load_cards;
use super::immediate_tx;

/// Persists a board's viewport, bumping its revision with an optimistic guard.
pub fn update_viewport(
    conn: &mut Connection,
    input: &UpdateViewportInput,
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();

    // One IMMEDIATE transaction so the stale-revision diagnosis below reads the
    // same state the guarded UPDATE saw.
    let tx = immediate_tx(conn)?;
    let changed = tx.execute(
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
        let exists: i64 = tx.query_row(
            "SELECT COUNT(*) FROM board_view_states WHERE board_id = ?1",
            [input.board_id.clone()],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(WorkspaceError::NotFound(input.board_id.clone()));
        }
        let actual: i64 = tx.query_row(
            "SELECT revision FROM board_view_states WHERE board_id = ?1",
            [input.board_id.clone()],
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

/// Loads the complete, self-contained projection of a board.
pub fn load_board_snapshot(
    conn: &Connection,
    board_id: &str,
) -> Result<BoardSnapshot, WorkspaceError> {
    let board = load_board_summary(conn, board_id)?;
    let breadcrumbs = load_breadcrumbs(conn, board_id)?;
    let viewport = load_viewport(conn, board_id)?;
    let cards = load_cards(conn, board_id, true, false)?;
    let unsorted_cards = load_cards(conn, board_id, false, true)?;

    Ok(BoardSnapshot {
        board,
        breadcrumbs,
        viewport,
        cards,
        unsorted_cards,
    })
}

/// Loads the Home (root) board summary.
pub fn load_home_board(conn: &Connection) -> Result<BoardSummary, WorkspaceError> {
    let root_id: String =
        conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
            r.get(0)
        })?;
    conn.query_row(
        "SELECT b.id, b.title, b.parent_board_id, b.revision, b.color_token, b.symbol,
                ca.id, ca.file_name, ca.mime_type, ca.width, ca.height, ca.size_bytes, ca.file_path
         FROM boards b
         LEFT JOIN assets ca ON ca.id = b.cover_asset_id
         WHERE b.id = ?1",
        [root_id],
        |row| {
            let cover_asset = if row.get::<_, Option<String>>(6)?.is_some() {
                Some(AssetDto {
                    id: row.get(6)?,
                    file_name: row.get(7)?,
                    mime_type: row.get(8)?,
                    width: row.get(9)?,
                    height: row.get(10)?,
                    size_bytes: row.get(11)?,
                    file_path: row.get(12)?,
                })
            } else {
                None
            };
            Ok(BoardSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                parent_board_id: row.get(2)?,
                revision: row.get(3)?,
                color_token: row.get(4)?,
                symbol: row.get(5)?,
                cover_asset,
            })
        },
    )
    .map_err(WorkspaceError::from)
}

/// Lists all active (non-trashed) boards.
pub fn list_boards(conn: &Connection) -> Result<Vec<BoardSummary>, WorkspaceError> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.title, b.parent_board_id, b.revision, b.color_token, b.symbol,
                ca.id, ca.file_name, ca.mime_type, ca.width, ca.height, ca.size_bytes, ca.file_path
         FROM boards b
         LEFT JOIN assets ca ON ca.id = b.cover_asset_id
         WHERE b.deleted_at IS NULL
         ORDER BY b.created_at, b.id",
    )?;
    let rows = stmt.query_map([], |row| {
        let cover_asset = if row.get::<_, Option<String>>(6)?.is_some() {
            Some(AssetDto {
                id: row.get(6)?,
                file_name: row.get(7)?,
                mime_type: row.get(8)?,
                width: row.get(9)?,
                height: row.get(10)?,
                size_bytes: row.get(11)?,
                file_path: row.get(12)?,
            })
        } else {
            None
        };
        Ok(BoardSummary {
            id: row.get(0)?,
            title: row.get(1)?,
            parent_board_id: row.get(2)?,
            revision: row.get(3)?,
            color_token: row.get(4)?,
            symbol: row.get(5)?,
            cover_asset,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub(super) fn load_board_summary(
    conn: &Connection,
    board_id: &str,
) -> Result<BoardSummary, WorkspaceError> {
    conn.query_row(
        "SELECT b.id, b.title, b.parent_board_id, b.revision, b.color_token, b.symbol,
                ca.id, ca.file_name, ca.mime_type, ca.width, ca.height, ca.size_bytes, ca.file_path
         FROM boards b
         LEFT JOIN assets ca ON ca.id = b.cover_asset_id
         WHERE b.id = ?1 AND b.deleted_at IS NULL",
        [board_id],
        |row| {
            let cover_asset = if row.get::<_, Option<String>>(6)?.is_some() {
                Some(AssetDto {
                    id: row.get(6)?,
                    file_name: row.get(7)?,
                    mime_type: row.get(8)?,
                    width: row.get(9)?,
                    height: row.get(10)?,
                    size_bytes: row.get(11)?,
                    file_path: row.get(12)?,
                })
            } else {
                None
            };
            Ok(BoardSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                parent_board_id: row.get(2)?,
                revision: row.get(3)?,
                color_token: row.get(4)?,
                symbol: row.get(5)?,
                cover_asset,
            })
        },
    )
    .map_err(WorkspaceError::from)
}

/// Collects the ancestor chain from Home down to `board_id`, inclusive.
pub(super) fn load_breadcrumbs(
    conn: &Connection,
    board_id: &str,
) -> Result<Vec<Breadcrumb>, WorkspaceError> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE ancestors(id, title, parent_board_id, depth) AS (
            SELECT id, title, parent_board_id, 0 FROM boards WHERE id = ?1
            UNION ALL
            SELECT b.id, b.title, b.parent_board_id, a.depth - 1
            FROM boards b
            JOIN ancestors a ON b.id = a.parent_board_id
        )
        SELECT id, title FROM ancestors ORDER BY depth ASC",
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
