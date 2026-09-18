//! Board-related Tauri commands.

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::State;

pub use crate::domain::board_service;
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{
    BoardSnapshot, BoardSummary, CreateChildBoardInput, DuplicateBoardInput, DuplicateBoardReceipt,
    MoveBoardInput, UpdateViewportInput,
};
use crate::repositories::workspace_repository;

/// The application-wide SQLite connection, guarded so commands can share it.
pub type DbState<'a> = State<'a, Mutex<Connection>>;

/// Loads the full snapshot of a board by id.
#[tauri::command]
pub fn load_board_snapshot(
    db: DbState<'_>,
    board_id: String,
) -> Result<BoardSnapshot, WorkspaceError> {
    let conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::load_board_snapshot(&conn, &board_id)
}

/// Returns the Home (root) board summary.
#[tauri::command]
pub fn get_home_board(db: DbState<'_>) -> Result<BoardSummary, WorkspaceError> {
    let conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
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
                Some(crate::domain::models::AssetDto {
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

/// Persists a board's viewport.
#[tauri::command]
pub fn save_viewport(db: DbState<'_>, input: UpdateViewportInput) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::update_viewport(&mut conn, &input)
}

/// Returns SQLite's `PRAGMA data_version`, which changes whenever another
/// connection commits. The frontend polls it to detect external (agent) writes.
#[tauri::command]
pub fn get_data_version(db: DbState<'_>) -> Result<i64, WorkspaceError> {
    let conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    conn.query_row("PRAGMA data_version", [], |r| r.get(0))
        .map_err(WorkspaceError::from)
}

/// Creates a child board and its primary portal card atomically.
#[tauri::command]
pub fn create_child_board(
    db: DbState<'_>,
    input: CreateChildBoardInput,
) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    board_service::create_child_board(&mut conn, &input)
}

/// Renames a board (portal title and breadcrumbs derive from this record).
#[tauri::command]
pub fn rename_board(
    db: DbState<'_>,
    board_id: String,
    title: String,
) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    board_service::rename_board(&mut conn, &board_id, &title)
}

/// Atomically reparents a Board and its portal card to a new parent board.
#[tauri::command]
pub fn move_board(db: DbState<'_>, input: MoveBoardInput) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    board_service::move_board(&mut conn, &input)
}

/// Sets a Board's cover image from an already-imported asset id.
#[tauri::command]
pub fn set_board_cover(
    db: DbState<'_>,
    board_id: String,
    asset_id: String,
) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    board_service::set_board_cover(&mut conn, &board_id, Some(&asset_id))
}

/// Removes a Board's cover image, returning to the color/symbol tile.
#[tauri::command]
pub fn remove_board_cover(db: DbState<'_>, board_id: String) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    board_service::set_board_cover(&mut conn, &board_id, None)
}

/// Duplicates a Board Portal's whole subtree, recursively, in one atomic
/// transaction (todo.md №16).
#[tauri::command]
pub fn duplicate_board(
    db: DbState<'_>,
    input: DuplicateBoardInput,
) -> Result<DuplicateBoardReceipt, WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    crate::domain::duplicate_board::duplicate_board(&mut conn, &input)
}
