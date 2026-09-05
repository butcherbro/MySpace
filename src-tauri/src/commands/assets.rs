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
/// directory and recording metadata. Returns the stored asset DTO.
#[tauri::command]
pub fn import_asset(
    app: AppHandle,
    db: DbState<'_>,
    input: ImportAssetInput,
) -> Result<AssetDto, WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    let dir = asset_dir(&app);
    asset_service::import_asset(&mut conn, &dir, &input)
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
