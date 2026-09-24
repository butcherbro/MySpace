//! Asset-related Tauri commands.
//!
//! Every command is `async` and touches the database only through the
//! [`Workspace`] handle: reads on the pool, writes as a [`Mutation`] on the
//! writer thread. Slow file I/O (copying a dropped file, reading the
//! clipboard) runs in `spawn_blocking`, never on the writer thread.

use tauri::State;

use crate::app::Workspace;
use crate::domain::asset_service;
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{AssetDto, ImportAssetInput};
use crate::domain::mutation::Mutation;
use crate::telemetry::instrument_async;

/// Imports a file into the asset store by copying it into the app's asset
/// directory and recording metadata. Returns the stored asset DTO. The copy runs
/// on a blocking task, off the writer thread; the writer thread only inserts the
/// row once the file is already in place.
#[tauri::command]
pub async fn import_asset(
    ws: State<'_, Workspace>,
    input: ImportAssetInput,
) -> Result<AssetDto, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("import_asset", async move {
        let dir = ws.paths().assets_dir();

        // Idempotent replay under a pooled read, before any bytes are copied.
        let replay_id = input.id.clone();
        let replay = ws
            .read(move |conn| asset_service::load_asset(conn, &replay_id))
            .await?;
        if let Some(existing) = replay {
            return Ok(existing);
        }

        let staged = tokio::task::spawn_blocking(move || {
            asset_service::stage_image_asset(
                &dir,
                &input.id,
                &input.file_name,
                &input.mime_type,
                &input.source_path,
            )
        })
        .await
        .map_err(|e| WorkspaceError::Database(format!("stage task failed: {e}")))??;

        record_or_reuse_staged(&ws, staged).await
    })
    .await
}

/// Records a staged asset, or reuses an existing asset with the same content.
///
/// Dedup by hash (P1.2): if a row with the staged file's SHA-256 already
/// exists, the staged file is discarded and the existing asset is returned, so
/// importing the same bytes twice keeps one file on disk. Callers must use the
/// returned asset's `id`, which differs from the requested id on a hit.
async fn record_or_reuse_staged(
    ws: &Workspace,
    staged: asset_service::StagedAsset,
) -> Result<AssetDto, WorkspaceError> {
    if let Some(sha256) = staged.asset.sha256.clone() {
        let existing = match ws
            .read(move |conn| asset_service::find_asset_by_sha256(conn, &sha256))
            .await
        {
            Ok(existing) => existing,
            Err(error) => {
                asset_service::discard_staged(&staged);
                return Err(error);
            }
        };
        if let Some(existing) = existing {
            asset_service::discard_staged(&staged);
            return Ok(existing);
        }
    }

    match ws.apply(Mutation::InsertAsset(staged.asset.clone())).await {
        Ok(_) => Ok(staged.asset),
        Err(error) => {
            asset_service::discard_staged(&staged);
            Err(error)
        }
    }
}

/// Resolves an asset id to its absolute on-disk path. Used by "Copy File Path"
/// so the user gets a real filesystem location (e.g. to hand to an agent or
/// open in Finder), not a `myspace://` identifier or a relative name.
#[tauri::command]
pub async fn resolve_asset_path(
    ws: State<'_, Workspace>,
    asset_id: String,
) -> Result<String, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("resolve_asset_path", async move {
        let dir = ws.paths().assets_dir();
        let lookup_id = asset_id.clone();
        let asset = ws
            .read(move |conn| asset_service::load_asset(conn, &lookup_id))
            .await?
            .ok_or(WorkspaceError::NotFound(asset_id))?;

        tokio::task::spawn_blocking(move || {
            asset_service::asset_abs_path(&dir, &asset.file_path)
                .to_string_lossy()
                .to_string()
        })
        .await
        .map_err(|e| WorkspaceError::Database(format!("path task failed: {e}")))
    })
    .await
}

/// Copies the image files backing the given image card ids to the system
/// clipboard (as file references). Used by "Copy" on a selection of images.
#[tauri::command]
pub async fn copy_image_cards(
    ws: State<'_, Workspace>,
    card_ids: Vec<String>,
) -> Result<(), WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("copy_image_cards", async move {
        let dir = ws.paths().assets_dir();
        let ids = card_ids.clone();
        let paths = ws
            .read(move |conn| {
                let mut paths = Vec::new();
                for card_id in &ids {
                    let asset_id: String = conn.query_row(
                        "SELECT i.asset_id
                     FROM image_cards i
                     JOIN cards c ON c.id = i.card_id
                     WHERE c.id = ?1 AND c.deleted_at IS NULL",
                        [card_id.as_str()],
                        |r| r.get(0),
                    )?;
                    let asset = asset_service::load_asset(conn, &asset_id)?
                        .ok_or(WorkspaceError::NotFound(asset_id))?;
                    paths.push(asset_service::asset_abs_path(&dir, &asset.file_path));
                }
                Ok(paths)
            })
            .await?;

        tokio::task::spawn_blocking(move || {
            crate::commands::clipboard::copy_image_files(&paths).map_err(WorkspaceError::Database)
        })
        .await
        .map_err(|e| WorkspaceError::Database(format!("clipboard task failed: {e}")))?
    })
    .await
}

/// Imports an image from the system clipboard as a managed asset and returns its
/// DTO. Used by "Set Cover from Clipboard". Returns NotFound when the clipboard
/// holds no image.
#[tauri::command]
pub async fn import_clipboard_image(ws: State<'_, Workspace>) -> Result<AssetDto, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("import_clipboard_image", async move {
        let dir = ws.paths().assets_dir();

        let staged = tokio::task::spawn_blocking(move || {
            let (bytes, mime_type, file_name) = crate::commands::clipboard::read_clipboard_image()
                .map_err(WorkspaceError::Database)?
                .ok_or_else(|| WorkspaceError::NotFound("clipboard image".to_string()))?;
            asset_service::stage_asset_bytes(&dir, &file_name, &mime_type, &bytes)
        })
        .await
        .map_err(|e| WorkspaceError::Database(format!("clipboard task failed: {e}")))??;

        record_or_reuse_staged(&ws, staged).await
    })
    .await
}
