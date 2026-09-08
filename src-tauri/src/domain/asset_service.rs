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

/// Validates that `id` is a well-formed UUID so it can never be used to build a
/// path that escapes the asset directory (path boundary). Frontend generates
/// UUIDv7, but this backstops any malformed input from the IPC boundary.
fn validate_uuid(id: &str) -> Result<(), WorkspaceError> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| WorkspaceError::ConstraintViolation(format!("invalid asset id: {id}")))
}

/// Copies the source file into `asset_dir/<id>.<ext>`, records metadata in the
/// `assets` table, and returns the stored `AssetDto`. Idempotent: an existing
/// asset id returns the existing row without re-copying.
pub fn import_asset(
    conn: &mut Connection,
    asset_dir: &Path,
    input: &ImportAssetInput,
) -> Result<AssetDto, WorkspaceError> {
    // Path boundary: the asset id is used to derive the on-disk filename, so it
    // must be a valid UUID (never a path component like `../`).
    validate_uuid(&input.id)?;

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
        file_path: relative.clone(),
    })
}

/// Stores already-validated downloaded bytes as a managed asset. Metadata
/// enrichment uses this instead of temporary source files, but the persistence
/// model remains identical to user-imported assets: bytes are copied under the
/// app data dir and SQLite stores only metadata.
pub fn store_asset_bytes(
    conn: &mut Connection,
    asset_dir: &Path,
    file_name: &str,
    mime_type: &str,
    bytes: &[u8],
) -> Result<AssetDto, WorkspaceError> {
    let id = uuid::Uuid::now_v7().to_string();
    let ext = extension_for_mime(mime_type);
    let relative = format!("{id}.{ext}");
    let dest = asset_dir.join(&relative);

    fs::create_dir_all(asset_dir)
        .map_err(|e| WorkspaceError::Database(format!("cannot create asset dir: {e}")))?;
    fs::write(&dest, bytes)
        .map_err(|e| WorkspaceError::Database(format!("cannot store asset bytes: {e}")))?;

    let now = db::migrations::now_millis();
    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at)
         VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, ?6)",
        params![id, relative, mime_type, file_name, bytes.len() as i64, now],
    )?;

    Ok(AssetDto {
        id,
        file_name: file_name.to_string(),
        mime_type: mime_type.to_string(),
        width: None,
        height: None,
        size_bytes: bytes.len() as i64,
        file_path: relative,
    })
}

/// Loads an asset's metadata by id, if it exists.
pub fn load_asset(conn: &Connection, id: &str) -> Result<Option<AssetDto>, WorkspaceError> {
    let mut stmt = conn.prepare(
        "SELECT id, file_name, mime_type, width, height, size_bytes, file_path FROM assets WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map([id], |row| {
        Ok(AssetDto {
            id: row.get(0)?,
            file_name: row.get(1)?,
            mime_type: row.get(2)?,
            width: row.get(3)?,
            height: row.get(4)?,
            size_bytes: row.get(5)?,
            file_path: row.get(6)?,
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
        "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
        "image/svg+xml" => "svg",
        "image/heic" => "heic",
        _ => "bin",
    }
}

/// Mark-and-sweep collection of orphaned managed assets. An asset is referenced
/// if any remaining `image_cards`/`embed_cards`/`boards` row points at it; every
/// other asset file is deleted (file first, then its metadata row). A missing
/// file counts as success so an interrupted sweep converges on the next run.
/// Returns the number of assets collected.
pub fn collect_orphaned_assets(
    conn: &mut Connection,
    asset_dir: &Path,
) -> Result<i64, WorkspaceError> {
    let orphans: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT a.id, a.file_path FROM assets a
             WHERE a.id NOT IN (
                 SELECT asset_id FROM image_cards WHERE asset_id IS NOT NULL
                 UNION
                 SELECT asset_id FROM embed_cards WHERE asset_id IS NOT NULL
                 UNION
                 SELECT favicon_asset_id FROM embed_cards WHERE favicon_asset_id IS NOT NULL
                 UNION
                 SELECT cover_asset_id FROM boards WHERE cover_asset_id IS NOT NULL
             )",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let mut collected: i64 = 0;
    for (id, file_path) in orphans {
        if !crate::is_safe_asset_name(&file_path) {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "unsafe asset filename: {file_path}"
            )));
        }
        let abs = asset_dir.join(&file_path);
        match fs::remove_file(&abs) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(WorkspaceError::Database(format!(
                    "cannot delete asset: {e}"
                )))
            }
        }
        conn.execute("DELETE FROM assets WHERE id = ?1", params![id])?;
        collected += 1;
    }
    Ok(collected)
}
