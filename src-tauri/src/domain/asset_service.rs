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
use crate::domain::models::{AssetDto, CreateFileCardInput, ImportAssetInput};

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

    let staged = stage_image_asset(
        asset_dir,
        &input.id,
        &input.file_name,
        &input.mime_type,
        &input.source_path,
    )?;
    if let Err(error) = insert_asset_row(conn, &staged.asset) {
        discard_staged(&staged);
        return Err(error);
    }
    Ok(staged.asset)
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

/// Writes already-validated bytes into the asset directory as a staged asset
/// (file only, no database access). The caller records the row through
/// `Mutation::InsertAsset` and calls [`discard_staged`] if that fails. This is
/// the split of [`store_asset_bytes`] required by the single-writer model: file
/// I/O before the mutation is queued, the row insert on the writer thread.
pub fn stage_asset_bytes(
    asset_dir: &Path,
    file_name: &str,
    mime_type: &str,
    bytes: &[u8],
) -> Result<StagedAsset, WorkspaceError> {
    let id = uuid::Uuid::now_v7().to_string();
    let ext = extension_for_mime(mime_type);
    let relative = format!("{id}.{ext}");
    let dest = asset_dir.join(&relative);

    fs::create_dir_all(asset_dir)
        .map_err(|e| WorkspaceError::Database(format!("cannot create asset dir: {e}")))?;
    fs::write(&dest, bytes)
        .map_err(|e| WorkspaceError::Database(format!("cannot store asset bytes: {e}")))?;

    Ok(StagedAsset {
        asset: AssetDto {
            id,
            file_name: file_name.to_string(),
            mime_type: mime_type.to_string(),
            width: None,
            height: None,
            size_bytes: bytes.len() as i64,
            file_path: relative,
        },
        file_abs: dest,
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

/// Stable, content-free summary of a GC failure for startup logging. The full
/// `WorkspaceError` message can embed user content (asset filenames, source
/// paths, database text), so it must never be formatted into a log line.
pub fn gc_failure_summary(err: &WorkspaceError) -> &'static str {
    match err {
        WorkspaceError::ConstraintViolation(_) => "unsafe asset filename",
        WorkspaceError::Database(_) => "database failure",
        WorkspaceError::NotFound(_) => "not found",
        WorkspaceError::StaleRevision { .. } => "stale revision",
        WorkspaceError::RootBoardProtected => "root board protected",
    }
}

/// A managed file written into the asset directory whose metadata row has not
/// been inserted yet. Keeping the file separate from the row is what allows slow
/// I/O (copy, Quick Look) to run outside the database lock, and lets a failed
/// commit remove exactly the files that commit created.
pub struct StagedAsset {
    pub asset: AssetDto,
    /// Absolute path of the file created for this asset.
    pub file_abs: PathBuf,
}

/// Removes the file created by a staging step. Used to unwind a failed commit;
/// it never touches the original source file.
pub fn discard_staged(staged: &StagedAsset) {
    let _ = fs::remove_file(&staged.file_abs);
}

/// Validates `id`, confirms `source_path` is a readable file, and copies it to
/// `asset_dir/<id>.<extension>`. No database access: the caller decides when the
/// lock is taken.
fn stage_copy(
    asset_dir: &Path,
    id: &str,
    extension: &str,
    file_name: &str,
    mime_type: &str,
    source_path: &str,
    not_a_file: &str,
) -> Result<StagedAsset, WorkspaceError> {
    validate_uuid(id)?;

    let source = Path::new(source_path);
    let meta = fs::metadata(source)
        .map_err(|e| WorkspaceError::ConstraintViolation(format!("cannot read source: {e}")))?;
    if !meta.is_file() {
        return Err(WorkspaceError::ConstraintViolation(not_a_file.into()));
    }

    let relative = format!("{id}.{extension}");
    let dest = asset_dir.join(&relative);
    fs::create_dir_all(asset_dir)
        .map_err(|e| WorkspaceError::Database(format!("cannot create asset dir: {e}")))?;
    if let Err(e) = fs::copy(source, &dest) {
        let _ = fs::remove_file(&dest);
        return Err(WorkspaceError::Database(format!("cannot copy asset: {e}")));
    }

    Ok(StagedAsset {
        file_abs: dest,
        asset: AssetDto {
            id: id.to_string(),
            file_name: file_name.to_string(),
            mime_type: mime_type.to_string(),
            width: None,
            height: None,
            size_bytes: meta.len() as i64,
            file_path: relative,
        },
    })
}

/// Stages an image asset. The extension comes from the mime type so it stays
/// stable across filesystems; unknown types fall back to `.bin`.
pub fn stage_image_asset(
    asset_dir: &Path,
    id: &str,
    file_name: &str,
    mime_type: &str,
    source_path: &str,
) -> Result<StagedAsset, WorkspaceError> {
    stage_copy(
        asset_dir,
        id,
        extension_for_mime(mime_type),
        file_name,
        mime_type,
        source_path,
        "asset source is not a file",
    )
}

/// Stages a text-like File Card asset, keeping the source file's own extension.
pub fn stage_file_card_asset(
    asset_dir: &Path,
    id: &str,
    file_name: &str,
    mime_type: &str,
    source_path: &str,
) -> Result<StagedAsset, WorkspaceError> {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_else(|| "bin".to_string());
    stage_copy(
        asset_dir,
        id,
        &extension,
        file_name,
        mime_type,
        source_path,
        "file card target must be an existing file",
    )
}

/// Inserts an asset metadata row. Runs on the caller's connection or transaction,
/// so the caller owns the atomicity boundary.
pub fn insert_asset_row(conn: &Connection, asset: &AssetDto) -> Result<(), WorkspaceError> {
    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            asset.id,
            asset.file_path,
            asset.mime_type,
            asset.file_name,
            asset.width,
            asset.height,
            asset.size_bytes,
            db::migrations::now_millis()
        ],
    )?;
    Ok(())
}

/// Commits a File Card in one short transaction: the staged asset rows and the
/// card rows. On failure the transaction rolls back and only the files this call
/// staged are removed — never a pre-existing asset file and never the source.
pub fn commit_file_card(
    conn: &mut Connection,
    input: &CreateFileCardInput,
    asset: &AssetDto,
    new_asset: Option<&StagedAsset>,
    preview_text: &str,
    thumbnail: Option<&StagedAsset>,
) -> Result<(), WorkspaceError> {
    let outcome = commit_file_card_rows(conn, input, asset, new_asset, preview_text, thumbnail);
    if outcome.is_err() {
        if let Some(new_asset) = new_asset {
            discard_staged(new_asset);
        }
        if let Some(thumbnail) = thumbnail {
            discard_staged(thumbnail);
        }
    }
    outcome
}

fn commit_file_card_rows(
    conn: &mut Connection,
    input: &CreateFileCardInput,
    asset: &AssetDto,
    new_asset: Option<&StagedAsset>,
    preview_text: &str,
    thumbnail: Option<&StagedAsset>,
) -> Result<(), WorkspaceError> {
    let tx = conn.transaction()?;
    if new_asset.is_some() {
        insert_asset_row(&tx, asset)?;
    }
    if let Some(thumbnail) = thumbnail {
        insert_asset_row(&tx, &thumbnail.asset)?;
    }
    crate::repositories::workspace_repository::insert_file_card_rows(
        &tx,
        input,
        &asset.id,
        preview_text,
        thumbnail.map(|t| t.asset.id.as_str()),
    )?;
    tx.commit()?;
    Ok(())
}

/// Bounded inline preview for a text-like file: reads at most `limit` bytes from
/// the stored asset and returns them as UTF-8 (lossy), trimmed. The read is
/// bounded by `take`, so the whole file is never allocated. Binary content yields
/// an empty preview without error.
pub fn read_text_preview(asset_dir: &Path, asset: &AssetDto, limit: usize) -> String {
    use std::io::Read;
    let path = asset_abs_path(asset_dir, &asset.file_path);
    let file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(_) => return String::new(),
    };
    let mut buffer = Vec::new();
    if file
        .take((limit as u64).saturating_add(1))
        .read_to_end(&mut buffer)
        .is_err()
    {
        return String::new();
    }
    let preview = String::from_utf8_lossy(&buffer[..buffer.len().min(limit)]).into_owned();
    preview.trim().chars().take(limit).collect()
}

/// `qlmanage` can hang indefinitely (NSRunLoop never returns) when it has no
/// window-server session — headless CI, a detached agent shell, sandboxed
/// tests — or when the QuickLook generator for the source file never replies.
/// `Command::status()` blocks on that forever, so we poll `try_wait()` instead
/// and kill the child once this deadline passes.
#[cfg(target_os = "macos")]
const QLMANAGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Runs `qlmanage` with the given args, killing it if it does not exit within
/// `QLMANAGE_TIMEOUT`. Returns `true` only on a successful, bounded exit.
#[cfg(target_os = "macos")]
fn run_qlmanage_bounded(args: &[&std::ffi::OsStr]) -> bool {
    let mut child = match std::process::Command::new("qlmanage").args(args).spawn() {
        Ok(child) => child,
        Err(_) => return false,
    };
    let deadline = std::time::Instant::now() + QLMANAGE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => return false,
        }
    }
}

/// Renders a macOS Quick Look thumbnail (256px PNG) and stores it as a managed
/// file without touching the database. Returns None when the OS tool is
/// unavailable, hangs, or the file has no supported preview (never fails the
/// File Card import).
pub fn stage_thumbnail(
    asset_dir: &Path,
    source_path: &str,
) -> Result<Option<StagedAsset>, WorkspaceError> {
    #[cfg(target_os = "macos")]
    {
        let tmp = std::env::temp_dir().join(format!("myspace-thumb-{}", uuid::Uuid::now_v7()));
        let ok = run_qlmanage_bounded(&[
            std::ffi::OsStr::new("-t"),
            std::ffi::OsStr::new("-s"),
            std::ffi::OsStr::new("256"),
            std::ffi::OsStr::new("-o"),
            tmp.as_os_str(),
            std::ffi::OsStr::new(source_path),
        ]);
        if !ok {
            let _ = std::fs::remove_dir_all(&tmp);
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
        let dest = asset_dir.join(&relative);
        if let Err(e) = fs::write(&dest, &bytes) {
            let _ = fs::remove_file(&dest);
            return Err(WorkspaceError::Database(format!(
                "cannot store thumbnail: {e}"
            )));
        }
        Ok(Some(StagedAsset {
            file_abs: dest,
            asset: AssetDto {
                id,
                file_name: "thumbnail.png".to_string(),
                mime_type: "image/png".to_string(),
                width: Some(256),
                height: Some(256),
                size_bytes: bytes.len() as i64,
                file_path: relative,
            },
        }))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (asset_dir, source_path);
        Ok(None)
    }
}
