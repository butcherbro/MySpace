//! Trash-related Tauri commands.

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::State;

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{EmptyTrashResult, TrashSelectionInput, TrashSummaryDto};
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

/// Lists recoverable Trash batches (newest first) without mutating data.
#[tauri::command]
pub fn list_trash(db: DbState<'_>) -> Result<TrashSummaryDto, WorkspaceError> {
    let conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    trash_service::list_trash(&conn)
}

/// Permanently empties the Trash. Requires the exact token `EMPTY`; hard-deletes
/// trashed relational rows and returns the affected counts (asset GC is separate).
#[tauri::command]
pub fn empty_trash(
    db: DbState<'_>,
    confirmation: String,
) -> Result<EmptyTrashResult, WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    trash_service::empty_trash(&mut conn, &confirmation)
}
