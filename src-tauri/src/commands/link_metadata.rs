//! Tauri command for asynchronous Link Card metadata enrichment.

use tauri::{AppHandle, Manager};

use crate::db;
use crate::domain::errors::WorkspaceError;
use crate::domain::link_metadata::{enrich_embed_with_metadata, ReqwestMetadataFetcher};
use crate::domain::models::{EmbedCardDto, EnrichEmbedMetadataInput};

#[tauri::command]
pub async fn enrich_embed_metadata(
    app: AppHandle,
    input: EnrichEmbedMetadataInput,
) -> Result<EmbedCardDto, WorkspaceError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| WorkspaceError::Database(format!("failed to resolve app data dir: {e}")))?;
    let db_path = data_dir.join("workspace.sqlite3");
    let asset_dir = data_dir.join("assets");

    // reqwest blocking runs outside Tauri's async executor. This connection is
    // independent from the UI command mutex and holds no transaction while the
    // network fetch is in flight.
    tauri::async_runtime::spawn_blocking(move || {
        let fetcher = ReqwestMetadataFetcher::new()?;
        let mut conn = db::open(&db_path)?;
        enrich_embed_with_metadata(
            &mut conn,
            &asset_dir,
            &fetcher,
            &input.id,
            input.expected_revision,
        )
    })
    .await
    .map_err(|e| WorkspaceError::Database(format!("metadata task failed: {e}")))?
}
