//! Trash-related Tauri commands.

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::State;

use crate::domain::errors::WorkspaceError;
use crate::domain::models::TrashSelectionInput;
use crate::domain::trash_service;

/// The application-wide SQLite connection, guarded so commands can share it.
pub type DbState<'a> = State<'a, Mutex<Connection>>;

/// Trashes a note card, returning its trash batch id.
#[tauri::command]
pub fn trash_note(db: DbState<'_>, card_id: String) -> Result<String, WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    trash_service::trash_note(&mut conn, &card_id)
}

/// Trashes a board and its subtree, returning the trash batch id.
#[tauri::command]
pub fn trash_board(db: DbState<'_>, board_id: String) -> Result<String, WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    trash_service::trash_board(&mut conn, &board_id)
}

/// Restores a trash batch.
#[tauri::command]
pub fn restore_trash_batch(db: DbState<'_>, batch_id: String) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    trash_service::restore_trash_batch(&mut conn, &batch_id)
}

/// Atomically trashes a mixed selection (leaf cards + boards) in one
/// transaction, returning the single trash batch id.
#[tauri::command]
pub fn trash_selection(
    db: DbState<'_>,
    input: TrashSelectionInput,
) -> Result<String, WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    trash_service::trash_selection(&mut conn, &input)
}
