//! Startup backup: a validated, atomic, recoverable snapshot of the workspace
//! database and its managed assets.
//!
//! Each snapshot is staged into a temporary directory, validated
//! (`integrity_check` + `foreign_key_check`), and only then atomically renamed
//! into place. A small manifest records the schema version, asset count, and
//! validation status. Retention prunes only previously validated snapshots, and
//! a rate-limit prevents rapid dev restarts from evicting useful recovery points.
//!
//! This is the write-safety gate that must exist before agent writes or another
//! destructive migration (ADR-0005). Restoration is a separate, rehearsed flow.
//!
//! Backup 2.0 (P1.2): managed assets are immutable once written, so a snapshot
//! hard-links them instead of copying (falling back to a copy across volumes or
//! on filesystems without hard links). Ten snapshots of an unchanged asset dir
//! therefore cost about one copy of the bytes. The manifest lists every asset
//! with its `sha256` and whether it was linked. Retention is bounded by count
//! and by total bytes. Restoring always *copies* files out of a snapshot, so a
//! restored workspace never shares an inode with the snapshot it came from.
//!
//! Restore in the app: the database cannot be replaced while the `Workspace`
//! holds connections, so [`request_restore`] only writes a marker and the app
//! restarts; [`apply_pending_restore`] runs at the next startup, before the
//! database is opened.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

/// How many validated snapshots to keep. Oldest validated are pruned first.
pub const BACKUP_RETENTION: usize = 10;

/// Upper bound on the bytes the validated snapshots occupy together (2 GiB).
/// A hard-linked file is counted once however many snapshots link it, and a
/// file still linked from the live asset dir is not counted at all: pruning
/// could not free it. Oldest snapshots are pruned first until under the limit;
/// the newest validated snapshot is never pruned.
pub const BACKUP_MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Name of the restore marker file under the data dir.
pub const RESTORE_MARKER: &str = "restore-pending.json";

/// Minimum seconds between two startup snapshots. Rapid dev restarts within this
/// window skip the snapshot so they cannot consume all ten recovery points.
const RATE_LIMIT_SECONDS: u64 = 60;

/// Names a snapshot directory (lexicographically sortable newest/oldest):
/// `<unix secs>`, or `<unix secs>-<n>` when a snapshot already took this second
/// (`-` sorts before any digit, so the suffixed name still sorts after the
/// plain one and before the next second).
fn snapshot_dir_name(backup_root: &Path) -> String {
    let secs = now_secs();
    let base = format!("{secs}");
    if !backup_root.join(&base).exists() {
        return base;
    }
    let mut n = 1u32;
    loop {
        let candidate = format!("{secs}-{n}");
        if !backup_root.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Creation time encoded in a snapshot directory name (`<secs>[-<n>]`).
fn dir_created_secs(name: &str) -> Option<u64> {
    name.split('-').next()?.parse::<u64>().ok()
}

/// True when `name` is a bare directory name: one non-empty path component,
/// no separators, no `..`, not hidden (staging and pre-restore dirs are).
pub fn is_bare_snapshot_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && !name.contains('\0')
        && Path::new(name).components().count() == 1
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Returns the ordered list of backup dirs (oldest -> newest) by name.
fn existing_backups(backup_root: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = match fs::read_dir(backup_root) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .map(|e| e.path())
            .collect(),
        Err(_) => return Vec::new(),
    };
    dirs.sort();
    dirs
}

/// A single validated snapshot: its DB path.
struct Validated {
    db: PathBuf,
}

/// Returns only snapshots that carry a manifest marked `"ok"`, sorted oldest->newest.
fn validated_backups(backup_root: &Path) -> Vec<Validated> {
    let mut out = Vec::new();
    for dir in existing_backups(backup_root) {
        let manifest_path = dir.join("manifest.json");
        let Ok(bytes) = fs::read(&manifest_path) else {
            continue;
        };
        let Ok(json): Result<serde_json::Value, _> = serde_json::from_slice(&bytes) else {
            continue;
        };
        let valid = json
            .get("validation")
            .and_then(|v| v.as_str())
            .map(|s| s == "ok")
            .unwrap_or(false);
        if !valid {
            continue;
        }
        out.push(Validated {
            db: dir.join("workspace.sqlite3"),
        });
    }
    out
}

/// Writes a consistent SQLite backup of `src` to `dest`, folding WAL into the
/// main file so the snapshot is a standalone, single-file database.
fn backup_database(src: &Connection, dest: &Path) -> Result<(), rusqlite::Error> {
    let mut dst = Connection::open(dest)?;
    {
        let backup = rusqlite::backup::Backup::new(src, &mut dst)?;
        backup.run_to_completion(100, Duration::from_millis(10), None)?;
    }
    dst.execute_batch("PRAGMA journal_mode = DELETE; PRAGMA wal_checkpoint(TRUNCATE);")?;
    Ok(())
}

/// Places one asset file into the snapshot: a hard link when the filesystem
/// allows it (same volume), otherwise a copy. Returns whether it was linked.
/// A `NotFound` source is returned as an error so the caller can record a
/// missing asset; anything else is a real I/O error.
fn link_or_copy_file(src: &Path, dst: &Path) -> std::io::Result<bool> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::hard_link(src, dst) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(e),
        // Different volume, unsupported filesystem, link limit, ...: copy.
        Err(_) => {
            fs::copy(src, dst)?;
            Ok(false)
        }
    }
}

/// One asset as recorded in the snapshot manifest.
#[derive(Debug, Clone, Serialize)]
struct ManifestAsset {
    file_path: String,
    sha256: Option<String>,
    linked: bool,
}

/// What [`link_referenced_assets`] placed into a snapshot.
struct SnapshotAssets {
    /// Assets present in the snapshot (linked or copied).
    placed: Vec<ManifestAsset>,
    /// Relative paths of referenced files missing on disk.
    missing: Vec<String>,
}

/// True when the `assets` table of `conn` has a `sha256` column. A snapshot
/// taken right before migration 0020 is applied does not.
fn assets_have_sha256(conn: &Connection) -> bool {
    conn.prepare("SELECT sha256 FROM assets LIMIT 0").is_ok()
}

/// Hard-links (or copies, see [`link_or_copy_file`]) every asset referenced by
/// the snapshot DB into `assets/` under `dest`. A missing file is recorded as a
/// warning, not a hard failure, so the loss of one asset does not block the
/// whole snapshot (including the DB, which is what matters most for recovery).
/// Real I/O errors (e.g. permission denied) still fail the snapshot.
fn link_referenced_assets(
    conn: &Connection,
    assets_dir: &Path,
    dest: &Path,
) -> Result<SnapshotAssets, String> {
    let sql = if assets_have_sha256(conn) {
        "SELECT file_path, sha256 FROM assets"
    } else {
        "SELECT file_path, NULL FROM assets"
    };
    let rows: Vec<(String, Option<String>)> = {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };

    let mut placed = Vec::with_capacity(rows.len());
    let mut missing: Vec<String> = Vec::new();
    for (rel, sha256) in rows {
        let src = assets_dir.join(&rel);
        match link_or_copy_file(&src, &dest.join("assets").join(&rel)) {
            Ok(linked) => placed.push(ManifestAsset {
                file_path: rel,
                sha256,
                linked,
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                missing.push(rel);
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(SnapshotAssets { placed, missing })
}

/// Returns the current schema version (max applied migration).
fn schema_version(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// Validates a snapshot DB: integrity_check, foreign_key_check.
fn validate_snapshot(conn: &Connection) -> Result<(), String> {
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if integrity != "ok" {
        return Err(format!("integrity_check failed: {integrity}"));
    }

    // `foreign_key_check` returns one row per violation; count them.
    let fk_count: i64 = {
        let mut stmt = conn
            .prepare("PRAGMA foreign_key_check")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |_| Ok(())).map_err(|e| e.to_string())?;
        let mut count = 0i64;
        for r in rows {
            r.map_err(|e| e.to_string())?;
            count += 1;
        }
        count
    };
    if fk_count > 0 {
        return Err(format!("foreign_key_check: {fk_count} violation(s)"));
    }
    Ok(())
}

/// Removes validated snapshots beyond the default retention limits
/// ([`BACKUP_RETENTION`], [`BACKUP_MAX_TOTAL_BYTES`]), oldest first.
/// Unvalidated dirs are left in place.
pub fn prune_old_backups(backup_root: &Path) {
    prune_backups_with_limits(backup_root, BACKUP_RETENTION, BACKUP_MAX_TOTAL_BYTES);
}

/// Prunes validated snapshots, oldest first, until at most `max_count` remain
/// and together they occupy at most `max_total_bytes` (see
/// [`snapshots_disk_bytes`]). The newest validated snapshot is never pruned,
/// even when it alone exceeds the byte limit. Unvalidated dirs are left alone.
pub fn prune_backups_with_limits(backup_root: &Path, max_count: usize, max_total_bytes: u64) {
    let mut dirs: Vec<PathBuf> = validated_backups(backup_root)
        .into_iter()
        .filter_map(|v| v.db.parent().map(Path::to_path_buf))
        .collect();
    while dirs.len() > 1
        && (dirs.len() > max_count || snapshots_disk_bytes(&dirs) > max_total_bytes)
    {
        let oldest = dirs.remove(0);
        let _ = fs::remove_dir_all(&oldest);
    }
}

/// Bytes the given snapshot dirs occupy on disk *because of the snapshots*,
/// i.e. what deleting all of them could free.
///
/// On unix, a hard-linked file is counted once however many snapshots link it
/// (keyed by device + inode), and a file that also has links outside these
/// snapshots (`nlink` greater than the links found here, typically the live
/// `assets/` file it was linked from) is not counted: pruning would not free
/// it. On other platforms every file is counted.
pub fn snapshots_disk_bytes(dirs: &[PathBuf]) -> u64 {
    let mut files = Vec::new();
    for dir in dirs {
        collect_files(dir, &mut files);
    }
    count_unique_bytes(&files)
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_files(&entry.path(), out);
        } else if file_type.is_file() {
            out.push(entry.path());
        }
    }
}

#[cfg(unix)]
fn count_unique_bytes(files: &[PathBuf]) -> u64 {
    use std::collections::HashMap;
    use std::os::unix::fs::MetadataExt;

    let mut total = 0u64;
    // (dev, ino) -> (size, nlink, links seen in these dirs)
    let mut shared: HashMap<(u64, u64), (u64, u64, u64)> = HashMap::new();
    for path in files {
        let Ok(meta) = fs::symlink_metadata(path) else {
            continue;
        };
        if meta.nlink() <= 1 {
            total += meta.len();
        } else {
            let entry =
                shared
                    .entry((meta.dev(), meta.ino()))
                    .or_insert((meta.len(), meta.nlink(), 0));
            entry.2 += 1;
        }
    }
    for (size, nlink, seen) in shared.into_values() {
        if seen >= nlink {
            total += size;
        }
    }
    total
}

#[cfg(not(unix))]
fn count_unique_bytes(files: &[PathBuf]) -> u64 {
    files
        .iter()
        .filter_map(|p| fs::metadata(p).ok())
        .map(|m| m.len())
        .sum()
}

/// Apparent size of one snapshot dir: the sum of its file sizes, whether or
/// not they are hard links shared with other snapshots or the live assets.
fn dir_apparent_bytes(dir: &Path) -> u64 {
    let mut files = Vec::new();
    collect_files(dir, &mut files);
    files
        .iter()
        .filter_map(|p| fs::symlink_metadata(p).ok())
        .map(|m| m.len())
        .sum()
}

/// Returns true if the most recent validated snapshot is fresher than the rate
/// limit, meaning this launch should skip creating another snapshot.
fn within_rate_limit(backup_root: &Path) -> bool {
    let validated = validated_backups(backup_root);
    let Some(last) = validated.last() else {
        return false;
    };
    let Some(name) = last.db.parent().and_then(|p| p.file_name()) else {
        return false;
    };
    let Some(ts) = dir_created_secs(&name.to_string_lossy()) else {
        return false;
    };
    now_secs().saturating_sub(ts) < RATE_LIMIT_SECONDS
}

/// The outcome of a successfully published snapshot.
pub struct SnapshotReport {
    /// The final snapshot directory.
    pub dir: PathBuf,
    /// Relative paths of referenced asset files that were missing on disk.
    /// Non-fatal: the snapshot is still published with `"validation": "ok"`.
    pub missing_assets: Vec<String>,
    /// Assets placed into the snapshot (linked or copied).
    pub asset_count: usize,
    /// How many of those were hard-linked rather than copied.
    pub linked_asset_count: usize,
}

/// Creates one validated, atomic snapshot into `backup_root` and returns a
/// report of the final snapshot directory (and any missing assets) on success.
/// Staging, validation (integrity/foreign-key checks) and manifest write all
/// fail the snapshot (no partial success); a missing asset file does not.
fn create_snapshot(
    db_path: &Path,
    assets_dir: &Path,
    backup_root: &Path,
) -> Result<SnapshotReport, String> {
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    let staging = backup_root.join(format!(".staging-{}", uuid::Uuid::now_v7()));
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    let result = (|| -> Result<SnapshotAssets, String> {
        let dest_db = staging.join("workspace.sqlite3");
        backup_database(&conn, &dest_db).map_err(|e| e.to_string())?;

        let snap = Connection::open(&dest_db).map_err(|e| e.to_string())?;
        validate_snapshot(&snap)?;
        let assets = link_referenced_assets(&snap, assets_dir, &staging)?;
        let linked_count = assets.placed.iter().filter(|a| a.linked).count();

        let manifest = serde_json::json!({
            "timestamp_secs": now_secs(),
            "schema_version": schema_version(&conn),
            "asset_count": assets.placed.len(),
            "linked_asset_count": linked_count,
            "assets": assets.placed,
            "missing_assets": assets.missing,
            "missing_asset_count": assets.missing.len(),
            "validation": "ok",
        });
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        fs::write(staging.join("manifest.json"), manifest_bytes).map_err(|e| e.to_string())?;
        Ok(assets)
    })();

    let assets = match result {
        Ok(assets) => assets,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }
    };

    let final_dir = backup_root.join(snapshot_dir_name(backup_root));
    fs::rename(&staging, &final_dir).map_err(|e| e.to_string())?;
    prune_old_backups(backup_root);
    Ok(SnapshotReport {
        dir: final_dir,
        missing_assets: assets.missing,
        asset_count: assets.placed.len(),
        linked_asset_count: assets.placed.iter().filter(|a| a.linked).count(),
    })
}

/// Performs a full, validated, atomic startup snapshot. Best-effort: never panics
/// and never blocks startup. A snapshot is published only after staging, copying
/// all referenced assets, validating, and writing a success manifest.
pub fn snapshot_on_startup(db_path: &Path, assets_dir: &Path, backup_root: &Path) {
    if !db_path.exists() {
        return;
    }
    if within_rate_limit(backup_root) {
        return;
    }
    tracing::info!("backup: startup snapshot started");
    let started = Instant::now();
    match create_snapshot(db_path, assets_dir, backup_root) {
        Ok(report) => {
            tracing::info!(
                elapsed_ms = started.elapsed().as_millis() as u64,
                asset_count = report.asset_count,
                linked_asset_count = report.linked_asset_count,
                missing_asset_count = report.missing_assets.len(),
                "backup: startup snapshot published"
            );
            if !report.missing_assets.is_empty() {
                eprintln!(
                    "backup: {} referenced asset file(s) missing",
                    report.missing_assets.len()
                );
            }
        }
        Err(_) => {
            // The message can embed paths; log only that it failed.
            tracing::warn!(
                elapsed_ms = started.elapsed().as_millis() as u64,
                "backup: startup snapshot failed"
            );
        }
    }
}

/// Creates a synchronous, validated snapshot for a destructive operation,
/// bypassing the startup rate limit. Returns a report of the snapshot directory
/// (and any missing assets), or an error which the caller must treat as a hard
/// stop before mutating data.
pub fn snapshot_before_destructive_operation(
    db_path: &Path,
    assets_dir: &Path,
    backup_root: &Path,
) -> Result<SnapshotReport, String> {
    create_snapshot(db_path, assets_dir, backup_root)
}

/// Restores the live database from a validated snapshot, first moving the current
/// (possibly damaged) live DB and assets aside under `backups/` so nothing is
/// destroyed by the replacement. Returns the path of the preserved prior state.
///
/// This is the rehearsed recovery path required before agent writes.
pub fn restore_from_backup(
    snapshot_dir: &Path,
    db_path: &Path,
    assets_dir: &Path,
    backup_root: &Path,
) -> Result<PathBuf, String> {
    let snapshot_db = snapshot_dir.join("workspace.sqlite3");
    if !snapshot_db.exists() {
        return Err(format!("backup db not found: {}", snapshot_db.display()));
    }
    // Validate before restoring: never replace live data with a corrupt copy.
    let snap = Connection::open(&snapshot_db).map_err(|e| e.to_string())?;
    validate_snapshot(&snap)?;

    // Preserve the current live state.
    let preserve = backup_root.join(format!(".pre-restore-{}", now_secs()));
    fs::create_dir_all(&preserve).map_err(|e| e.to_string())?;
    if db_path.exists() {
        fs::rename(db_path, preserve.join("workspace.sqlite3")).map_err(|e| e.to_string())?;
    }
    // Move -wal/-shm aside too so no stale WAL re-attaches to the restored DB.
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{}", db_path.display(), suffix));
        if side.exists() {
            let _ = fs::rename(&side, preserve.join(side.file_name().unwrap_or_default()));
        }
    }
    if assets_dir.exists() {
        fs::rename(assets_dir, preserve.join("assets")).map_err(|e| e.to_string())?;
    }

    // Copy the snapshot into place (not rename, so the snapshot remains intact).
    fs::copy(&snapshot_db, db_path).map_err(|e| e.to_string())?;
    let snapshot_assets = snapshot_dir.join("assets");
    if snapshot_assets.exists() {
        copy_dir_recursive(&snapshot_assets, assets_dir).map_err(|e| e.to_string())?;
    }

    Ok(preserve)
}

/// Copies (never links) a directory tree. Restoring from a snapshot whose assets
/// are hard links must yield independent files, so nothing done to the restored
/// workspace can reach back into the snapshot.
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// One snapshot as shown in the "Restore from backup" dialog. Serialised in
/// camelCase for the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    /// Directory name under `backups/`; pass it back to `request_restore`.
    pub dir_name: String,
    /// Unix seconds when the snapshot was taken.
    pub created_at_secs: u64,
    /// Schema version recorded in the manifest (0 when unknown).
    pub schema_version: i64,
    /// Assets present in the snapshot.
    pub asset_count: i64,
    /// Apparent size of the snapshot (sum of its file sizes). Hard-linked
    /// assets are shared with other snapshots and the live workspace, so the
    /// sum over several snapshots overstates real disk usage.
    pub total_bytes: u64,
    /// True when the manifest says `"ok"` and the snapshot DB passes
    /// `integrity_check` and `foreign_key_check` right now.
    pub valid: bool,
}

/// Lists snapshots under `backup_root`, newest first. Staging and pre-restore
/// directories (hidden names) are not listed. Every snapshot DB is opened
/// read-only and validated, so this does blocking I/O proportional to the
/// number and size of snapshots.
pub fn list_backups(backup_root: &Path) -> Vec<BackupSummary> {
    let mut out = Vec::new();
    for dir in existing_backups(backup_root).into_iter().rev() {
        let Some(dir_name) = dir.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        if !is_bare_snapshot_name(&dir_name) {
            continue;
        }
        let manifest: Option<serde_json::Value> = fs::read(dir.join("manifest.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        let manifest_ok = manifest
            .as_ref()
            .and_then(|m| m.get("validation"))
            .and_then(|v| v.as_str())
            == Some("ok");
        let field_i64 = |key: &str| {
            manifest
                .as_ref()
                .and_then(|m| m.get(key))
                .and_then(|v| v.as_i64())
        };
        let created_at_secs = manifest
            .as_ref()
            .and_then(|m| m.get("timestamp_secs"))
            .and_then(|v| v.as_u64())
            .or_else(|| dir_created_secs(&dir_name))
            .unwrap_or(0);
        let valid = manifest_ok && validate_snapshot_file(&dir.join("workspace.sqlite3")).is_ok();
        out.push(BackupSummary {
            created_at_secs,
            schema_version: field_i64("schema_version").unwrap_or(0),
            asset_count: field_i64("asset_count").unwrap_or(0),
            total_bytes: dir_apparent_bytes(&dir),
            valid,
            dir_name,
        });
    }
    out
}

/// Opens a snapshot DB read-only (never creating it) and validates it.
fn validate_snapshot_file(db: &Path) -> Result<(), String> {
    if !db.is_file() {
        return Err(format!("backup db not found: {}", db.display()));
    }
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    validate_snapshot(&conn)
}

/// Resolves `snapshot` to a snapshot directory under `backup_root`, refusing
/// anything that is not a bare directory name of an existing snapshot.
fn resolve_snapshot_dir(backup_root: &Path, snapshot: &str) -> Result<PathBuf, String> {
    if !is_bare_snapshot_name(snapshot) {
        return Err(format!("invalid snapshot name: {snapshot:?}"));
    }
    let dir = backup_root.join(snapshot);
    if !dir.is_dir() {
        return Err(format!("snapshot not found: {snapshot}"));
    }
    Ok(dir)
}

/// Asks for `snapshot_dir_name` (a directory under `<data_dir>/backups`) to be
/// restored at the next startup: validates the snapshot, then writes
/// `<data_dir>/restore-pending.json` = `{ "snapshot": "<dir name>" }`
/// atomically. The caller restarts the app; [`apply_pending_restore`] does the
/// actual replacement before the database is opened.
pub fn request_restore(data_dir: &Path, snapshot_dir_name: &str) -> Result<(), String> {
    let backup_root = crate::app::WorkspacePaths::new(data_dir).backups_dir();
    let dir = resolve_snapshot_dir(&backup_root, snapshot_dir_name)?;
    validate_snapshot_file(&dir.join("workspace.sqlite3"))?;

    let marker = serde_json::json!({ "snapshot": snapshot_dir_name });
    let bytes = serde_json::to_vec_pretty(&marker).map_err(|e| e.to_string())?;
    let tmp = data_dir.join(format!("{RESTORE_MARKER}.tmp"));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, data_dir.join(RESTORE_MARKER)).map_err(|e| e.to_string())?;
    Ok(())
}

/// Applies a restore requested by [`request_restore`]. Must run at startup
/// before anything opens the workspace database. Returns `Ok(None)` when no
/// restore is pending, `Ok(Some(path))` with the preserved prior state after a
/// restore. The marker is deleted before restoring, so a restore that fails
/// (or crashes) is never retried in a loop; the error is returned for logging
/// and startup continues with the current database.
pub fn apply_pending_restore(data_dir: &Path) -> Result<Option<PathBuf>, String> {
    let marker = data_dir.join(RESTORE_MARKER);
    let bytes = match fs::read(&marker) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read restore marker: {e}")),
    };
    fs::remove_file(&marker).map_err(|e| format!("cannot remove restore marker: {e}"))?;

    let json: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid restore marker: {e}"))?;
    let snapshot = json
        .get("snapshot")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "restore marker has no snapshot".to_string())?;

    let paths = crate::app::WorkspacePaths::new(data_dir);
    let dir = resolve_snapshot_dir(&paths.backups_dir(), snapshot)?;
    restore_from_backup(
        &dir,
        &paths.db_path(),
        &paths.assets_dir(),
        &paths.backups_dir(),
    )
    .map(Some)
}
