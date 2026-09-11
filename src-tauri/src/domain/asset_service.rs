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

/// Mark-and-sweep collection of orphaned managed assets. An asset is orphaned
/// only when no durable owner references it: `image_cards.asset_id`,
/// `embed_cards.asset_id`, `embed_cards.favicon_asset_id`, `boards.cover_asset_id`,
/// `file_cards.asset_id`, or `file_cards.preview_asset_id`. `favicon_cache` is an
/// acceleration index, not an owner: a cache-only asset may be collected, but its
/// cache row is removed transactionally first. The metadata row is deleted inside
/// a transaction before the physical file, so an unknown durable foreign key
/// blocks collection before any bytes are removed. A missing physical file counts
/// as success so an interrupted sweep converges on the next run.
/// Returns the number of assets collected.
pub fn collect_orphaned_assets(
    conn: &mut Connection,
    asset_dir: &Path,
) -> Result<i64, WorkspaceError> {
    let orphans: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT a.id, a.file_path
             FROM assets a
             WHERE NOT EXISTS (SELECT 1 FROM image_cards i WHERE i.asset_id = a.id)
               AND NOT EXISTS (SELECT 1 FROM embed_cards e WHERE e.asset_id = a.id)
               AND NOT EXISTS (SELECT 1 FROM embed_cards e WHERE e.favicon_asset_id = a.id)
               AND NOT EXISTS (SELECT 1 FROM boards b WHERE b.cover_asset_id = a.id)
               AND NOT EXISTS (SELECT 1 FROM file_cards f WHERE f.asset_id = a.id)
               AND NOT EXISTS (SELECT 1 FROM file_cards f WHERE f.preview_asset_id = a.id)",
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
        // Delete the cache index and the metadata row transactionally FIRST, so a
        // surviving durable FK blocks before any physical file is removed. Then
        // remove the file; NotFound is success (converged cleanup).
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM favicon_cache WHERE asset_id = ?1", params![id])?;
        tx.execute("DELETE FROM assets WHERE id = ?1", params![id])?;
        tx.commit()?;

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
        collected += 1;
    }
    Ok(collected)
}

/// Copies a text-like file into the managed asset store under a UUID, preserving
/// the original extension, and returns its metadata. `file_name` is the original
/// basename (kept for display); the on-disk name is `<uuid>.<ext>`.
pub fn import_file_asset(
    conn: &mut Connection,
    asset_dir: &Path,
    id: &str,
    file_name: &str,
    mime_type: &str,
    source_path: &str,
) -> Result<AssetDto, WorkspaceError> {
    validate_uuid(id)?;
    if let Some(existing) = load_asset(conn, id)? {
        return Ok(existing);
    }

    let source = Path::new(source_path);
    let meta = fs::metadata(source)
        .map_err(|e| WorkspaceError::ConstraintViolation(format!("cannot read source: {e}")))?;
    if !meta.is_file() {
        return Err(WorkspaceError::ConstraintViolation(
            "file card target must be an existing file".into(),
        ));
    }
    let size_bytes = meta.len() as i64;

    // Keep the original extension on the stored copy.
    let ext = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_else(|| "bin".to_string());
    let relative = format!("{id}.{ext}");
    let dest = asset_dir.join(&relative);
    fs::create_dir_all(asset_dir)
        .map_err(|e| WorkspaceError::Database(format!("cannot create asset dir: {e}")))?;
    fs::copy(source, &dest)
        .map_err(|e| WorkspaceError::Database(format!("cannot copy asset: {e}")))?;

    let now = db::migrations::now_millis();
    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at)
         VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, ?6)",
        params![id, relative, mime_type, file_name, size_bytes, now],
    )?;

    Ok(AssetDto {
        id: id.to_string(),
        file_name: file_name.to_string(),
        mime_type: mime_type.to_string(),
        width: None,
        height: None,
        size_bytes,
        file_path: relative,
    })
}

/// Bounded inline preview for a text-like file: reads at most `limit` bytes from
/// the stored asset and returns them as UTF-8 (lossy), trimmed. Binary content
/// yields an empty preview without error.
pub fn read_text_preview(asset_dir: &Path, asset: &AssetDto, limit: usize) -> String {
    let path = asset_abs_path(asset_dir, &asset.file_path);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return String::new(),
    };
    let preview = String::from_utf8_lossy(&bytes[..bytes.len().min(limit)]).into_owned();
    let trimmed = preview.trim();
    trimmed.chars().take(limit).collect()
}

/// Generates a macOS Quick Look thumbnail (256px PNG) for a file and stores it as
/// a managed asset. Returns the asset id, or None when the OS tool is unavailable
/// or the file has no supported preview (never fails the File Card import).
pub fn generate_thumbnail(
    conn: &mut Connection,
    asset_dir: &Path,
    source_path: &str,
) -> Result<Option<String>, WorkspaceError> {
    #[cfg(target_os = "macos")]
    {
        let tmp = std::env::temp_dir().join(format!("myspace-thumb-{}", uuid::Uuid::now_v7()));
        let status = std::process::Command::new("qlmanage")
            .arg("-t")
            .arg("-s")
            .arg("256")
            .arg("-o")
            .arg(&tmp)
            .arg(source_path)
            .status();
        let ok = matches!(status, Ok(s) if s.success());
        if !ok {
            return Ok(None);
        }
        // qlmanage writes `<filename>.png` next to `-o` (or for some types a dir).
        let file = std::path::Path::new(source_path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let png = tmp.join(format!("{file}.png"));
        let bytes = match std::fs::read(&png) {
            Ok(b) => b,
            Err(_) => return Ok(None),
        };
        let _ = std::fs::remove_dir_all(&tmp);
        let id = uuid::Uuid::now_v7().to_string();
        let relative = format!("{id}.png");
        fs::create_dir_all(asset_dir)
            .map_err(|e| WorkspaceError::Database(format!("cannot create asset dir: {e}")))?;
        fs::write(asset_dir.join(&relative), &bytes)
            .map_err(|e| WorkspaceError::Database(format!("cannot store thumbnail: {e}")))?;
        let now = db::migrations::now_millis();
        conn.execute(
            "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at)
             VALUES (?1, ?2, 'image/png', ?3, 256, 256, ?4, ?5)",
            params![id, relative, "thumbnail.png", bytes.len() as i64, now],
        )?;
        Ok(Some(id))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (conn, asset_dir, source_path);
        Ok(None)
    }
}
