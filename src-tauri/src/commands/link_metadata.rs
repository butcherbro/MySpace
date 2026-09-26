//! Tauri command for asynchronous Link Card metadata enrichment.
//!
//! The network phase runs on a blocking task with a pooled reader; the result
//! is applied as `Mutation::ApplyEmbedMetadata` on the writer thread (see
//! `domain::link_metadata::enrich_embed`). The command opens no connection.

use std::sync::Arc;

use tauri::State;

use crate::app::Workspace;
use crate::domain::errors::WorkspaceError;
use crate::domain::link_metadata::{enrich_embed, ReqwestMetadataFetcher};
use crate::domain::models::{EmbedCardDto, EnrichEmbedMetadataInput};
use crate::telemetry::instrument_async;

#[tauri::command]
pub async fn enrich_embed_metadata(
    ws: State<'_, Workspace>,
    input: EnrichEmbedMetadataInput,
) -> Result<EmbedCardDto, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("enrich_embed_metadata", async move {
        let fetcher = Arc::new(ReqwestMetadataFetcher::new()?);
        enrich_embed(&ws, fetcher, input.id).await
    })
    .await
}
