//! Search-related Tauri commands.

use tauri::State;

use crate::app::Workspace;
use crate::domain::errors::WorkspaceError;
use crate::domain::models::SearchResultDto;
use crate::repositories::workspace_repository;
use crate::telemetry::instrument_async;

/// Searches the workspace for the given query (Board titles, Note plain text,
/// Link Card title/URL/description). Returns an empty list for an empty query.
#[tauri::command]
pub async fn search_workspace(
    ws: State<'_, Workspace>,
    query: String,
) -> Result<Vec<SearchResultDto>, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("search_workspace", async move {
        ws.read(move |conn| workspace_repository::search_workspace(conn, &query))
            .await
    })
    .await
}
