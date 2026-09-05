//! Board-related Tauri commands.

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::State;

pub use crate::domain::board_service;
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{
    BoardSnapshot, BoardSummary, CreateChildBoardInput, MoveBoardInput, UpdateViewportInput,
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
        "SELECT id, title, parent_board_id, revision FROM boards WHERE id = ?1",
        [root_id],
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

/// Persists a board's viewport.
#[tauri::command]
pub fn save_viewport(db: DbState<'_>, input: UpdateViewportInput) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::update_viewport(&mut conn, &input)
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
