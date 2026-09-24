//! Search-related Tauri commands.

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::State;

use crate::domain::errors::WorkspaceError;
use crate::domain::models::SearchResultDto;
use crate::repositories::workspace_repository;

/// The application-wide SQLite connection, guarded so commands can share it.
pub type DbState<'a> = State<'a, Mutex<Connection>>;

/// Searches the workspace for the given query (Board titles, Note plain text,
/// Link Card title/URL/description). Returns an empty list for an empty query.
#[tauri::command]
pub fn search_workspace(
    db: DbState<'_>,
    query: String,
) -> Result<Vec<SearchResultDto>, WorkspaceError> {
    crate::telemetry::instrument("search_workspace", move || {
        let conn = db
            .lock()
            .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
        workspace_repository::search_workspace(&conn, &query)
    })
}
