//! Card-related Tauri commands.

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::State;

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{CreateNoteInput, UpdateNoteInput};
use crate::repositories::workspace_repository;

/// The application-wide SQLite connection, guarded so commands can share it.
pub type DbState<'a> = State<'a, Mutex<Connection>>;

/// Creates a note card on the given board in a single transaction.
#[tauri::command]
pub fn create_note(db: DbState<'_>, input: CreateNoteInput) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::create_note(&mut conn, &input)
}

/// Updates a note's content with an optimistic revision guard.
#[tauri::command]
pub fn update_note(db: DbState<'_>, input: UpdateNoteInput) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::update_note(&mut conn, &input)
}
