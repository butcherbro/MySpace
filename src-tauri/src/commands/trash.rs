//! Trash-related Tauri commands.

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::State;

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{EmptyTrashResult, TrashSelectionInput, TrashSummaryDto};
use crate::domain::trash_service;
use crate::AppPaths;

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

/// Permanently empties the Trash. Requires the exact token `EMPTY`. A fresh
/// validated backup is created first; if it cannot be created or validated the
/// operation is refused before anything is deleted. Hard-deletes trashed
/// relational rows and returns the affected counts (asset GC follows on startup).
#[tauri::command]
pub fn empty_trash(
    db: DbState<'_>,
    paths: State<'_, AppPaths>,
    confirmation: String,
) -> Result<EmptyTrashResult, WorkspaceError> {
    let db_path = paths.data_dir.join("workspace.sqlite3");
    let assets_dir = paths.data_dir.join("assets");
    let backup_dir = paths.data_dir.join("backups");

    // Mandatory pre-empty backup gate: refuse to mutate unless a fresh validated
    // snapshot is on disk.
    crate::db::backup::snapshot_before_destructive_operation(&db_path, &assets_dir, &backup_dir)
        .map_err(WorkspaceError::Database)?;

    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    trash_service::empty_trash(&mut conn, &confirmation)
}
