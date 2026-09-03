//! Domain service for the asset store: importing files into the app's asset
//! directory and recording metadata in SQLite.
//!
//! Files are copied in (never referenced in place) so a workspace card keeps a
//! stable reference to `asset_id` even if the original file moves or is deleted
//! outside the app (ADR / "copy-in" model). SQLite holds only metadata.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{AssetDto, ImportAssetInput};

use super::super::db;

/// Copies the source file into `asset_dir/<id>.<ext>`, records metadata in the
/// `assets` table, and returns the stored `AssetDto`. Idempotent: an existing
/// asset id returns the existing row without re-copying.
pub fn import_asset(
    conn: &mut Connection,
    asset_dir: &Path,
    input: &ImportAssetInput,
) -> Result<AssetDto, WorkspaceError> {
    // Idempotent replay: return the existing metadata unchanged.
    if let Some(existing) = load_asset(conn, &input.id)? {
        return Ok(existing);
    }

    let source = Path::new(&input.source_path);
    let meta = fs::metadata(source)
        .map_err(|e| WorkspaceError::ConstraintViolation(format!("cannot read source: {e}")))?;
    if !meta.is_file() {
        return Err(WorkspaceError::ConstraintViolation(
            "asset source is not a file".into(),
        ));
    }
    let size_bytes = meta.len() as i64;

    // The extension is derived from the provided mime type to stay stable across
    // filesystems; a fallback of ".bin" keeps the path valid for unknown types.
    let ext = extension_for_mime(&input.mime_type);
    // `file_path` is relative to `asset_dir` (the assets root), e.g. "abc.png".
    let relative = format!("{}.{}", input.id, ext);
    let dest = asset_dir.join(&relative);

    fs::create_dir_all(asset_dir)
        .map_err(|e| WorkspaceError::Database(format!("cannot create asset dir: {e}")))?;
    fs::copy(source, &dest)
        .map_err(|e| WorkspaceError::Database(format!("cannot copy asset: {e}")))?;

    let now = db::migrations::now_millis();
    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at)
         VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, ?6)",
        params![input.id, relative, input.mime_type, input.file_name, size_bytes, now],
    )?;

    Ok(AssetDto {
        id: input.id.clone(),
        file_name: input.file_name.clone(),
        mime_type: input.mime_type.clone(),
        width: None,
        height: None,
        size_bytes,
    })
}

/// Loads an asset's metadata by id, if it exists.
pub fn load_asset(conn: &Connection, id: &str) -> Result<Option<AssetDto>, WorkspaceError> {
    let mut stmt = conn.prepare(
        "SELECT id, file_name, mime_type, width, height, size_bytes FROM assets WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map([id], |row| {
        Ok(AssetDto {
            id: row.get(0)?,
            file_name: row.get(1)?,
            mime_type: row.get(2)?,
            width: row.get(3)?,
            height: row.get(4)?,
            size_bytes: row.get(5)?,
        })
    })?;

    match rows.next() {
        Some(row) => row.map(Some).map_err(WorkspaceError::from),
        None => Ok(None),
    }
}

/// Returns the absolute path to an asset file within `asset_dir`.
pub fn asset_abs_path(asset_dir: &Path, file_path: &str) -> PathBuf {
    asset_dir.join(file_path)
}

fn extension_for_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/heic" => "heic",
        _ => "bin",
    }
}
