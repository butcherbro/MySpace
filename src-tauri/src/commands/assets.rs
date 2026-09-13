//! Asset-related Tauri commands.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};

use crate::domain::asset_service;
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{AssetDto, ImportAssetInput};

pub type DbState<'a> = State<'a, Mutex<Connection>>;

/// The filesystem directory holding imported asset files.
fn asset_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("failed to resolve app data dir")
        .join("assets")
}

/// Imports a file into the asset store by copying it into the app's asset
/// directory and recording metadata. Returns the stored asset DTO. The copy runs
/// without holding the database lock; the lock is taken only for the row insert.
#[tauri::command]
pub fn import_asset(
    app: AppHandle,
    db: DbState<'_>,
    input: ImportAssetInput,
) -> Result<AssetDto, WorkspaceError> {
    let dir = asset_dir(&app);

    // Idempotent replay under a brief lock, before any bytes are copied.
    let replay = {
        let conn = db
            .lock()
            .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
        asset_service::load_asset(&conn, &input.id)?
    };
    if let Some(existing) = replay {
        return Ok(existing);
    }

    let staged = asset_service::stage_image_asset(
        &dir,
        &input.id,
        &input.file_name,
        &input.mime_type,
        &input.source_path,
    )?;

    let inserted = {
        let conn = db
            .lock()
            .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
        asset_service::insert_asset_row(&conn, &staged.asset)
    };
    if let Err(error) = inserted {
        asset_service::discard_staged(&staged);
        return Err(error);
    }
    Ok(staged.asset)
}

/// Resolves an asset id to its absolute on-disk path. Used by "Copy File Path"
/// so the user gets a real filesystem location (e.g. to hand to an agent or
/// open in Finder), not a `myspace://` identifier or a relative name.
#[tauri::command]
pub fn resolve_asset_path(
    app: AppHandle,
    db: DbState<'_>,
    asset_id: String,
) -> Result<String, WorkspaceError> {
    let conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    let asset = asset_service::load_asset(&conn, &asset_id)?
        .ok_or_else(|| WorkspaceError::NotFound(asset_id.clone()))?;
    let dir = asset_dir(&app);
    Ok(asset_service::asset_abs_path(&dir, &asset.file_path)
        .to_string_lossy()
        .to_string())
}

/// Copies the image files backing the given image card ids to the system
/// clipboard (as file references). Used by "Copy" on a selection of images.
#[tauri::command]
pub fn copy_image_cards(
    app: AppHandle,
    db: DbState<'_>,
    card_ids: Vec<String>,
) -> Result<(), WorkspaceError> {
    let conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    let dir = asset_dir(&app);

    let mut paths = Vec::new();
    for card_id in &card_ids {
        let asset_id: String = conn.query_row(
            "SELECT i.asset_id
             FROM image_cards i
             JOIN cards c ON c.id = i.card_id
             WHERE c.id = ?1 AND c.deleted_at IS NULL",
            [card_id.as_str()],
            |r| r.get(0),
        )?;
        let asset = asset_service::load_asset(&conn, &asset_id)?
            .ok_or(WorkspaceError::NotFound(asset_id))?;
        paths.push(asset_service::asset_abs_path(&dir, &asset.file_path));
    }

    crate::commands::clipboard::copy_image_files(&paths).map_err(WorkspaceError::Database)
}

/// Imports an image from the system clipboard as a managed asset and returns its
/// DTO. Used by "Set Cover from Clipboard". Returns NotFound when the clipboard
/// holds no image.
#[tauri::command]
pub fn import_clipboard_image(app: AppHandle, db: DbState<'_>) -> Result<AssetDto, WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    let dir = asset_dir(&app);

    let (bytes, mime_type, file_name) = crate::commands::clipboard::read_clipboard_image()
        .map_err(WorkspaceError::Database)?
        .ok_or_else(|| WorkspaceError::NotFound("clipboard image".to_string()))?;

    asset_service::store_asset_bytes(&mut conn, &dir, &file_name, &mime_type, &bytes)
}
