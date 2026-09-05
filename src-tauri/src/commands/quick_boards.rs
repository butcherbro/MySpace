//! Quick Boards Tauri commands: persisted, ordered references to Boards.

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::State;

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{AddQuickBoardInput, QuickBoardDto, ReorderQuickBoardsInput};
use crate::services::workspace_service::WorkspaceService;

/// The application-wide SQLite connection, guarded so commands can share it.
pub type DbState<'a> = State<'a, Mutex<Connection>>;

/// Lists Quick Boards in persisted order.
#[tauri::command]
pub fn list_quick_boards(db: DbState<'_>) -> Result<Vec<QuickBoardDto>, WorkspaceError> {
    let conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    WorkspaceService::list_quick_boards(&conn)
}

/// Adds a Quick Board reference idempotently (non-Home, active Board only).
#[tauri::command]
pub fn add_quick_board(db: DbState<'_>, input: AddQuickBoardInput) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    WorkspaceService::add_quick_board(&mut conn, &input)
}

/// Removes a Quick Board reference.
#[tauri::command]
pub fn remove_quick_board(db: DbState<'_>, board_id: String) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    WorkspaceService::remove_quick_board(&mut conn, &board_id)
}

/// Reorders Quick Board references transactionally.
#[tauri::command]
pub fn reorder_quick_boards(
    db: DbState<'_>,
    input: ReorderQuickBoardsInput,
) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    WorkspaceService::reorder_quick_boards(&mut conn, &input)
}
