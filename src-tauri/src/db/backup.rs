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

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

/// How many validated snapshots to keep. Oldest validated are pruned first.
const BACKUP_RETENTION: usize = 10;

/// Minimum seconds between two startup snapshots. Rapid dev restarts within this
/// window skip the snapshot so they cannot consume all ten recovery points.
const RATE_LIMIT_SECONDS: u64 = 60;

/// Names a snapshot directory (lexicographically sortable newest/oldest).
fn snapshot_dir_name() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", now.as_secs())
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

/// Copies an individual file, returning an error on failure (unlike the previous
/// best-effort sweep) so a snapshot with missing assets is not published as valid.
fn copy_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(src, dst)?;
    Ok(())
}

/// Copies every asset referenced by the live DB into `assets/` under `dest`.
/// Returns the number of assets copied. Missing asset files are recorded as an
/// error so the snapshot is not published as valid.
fn copy_referenced_assets(
    conn: &Connection,
    assets_dir: &Path,
    dest: &Path,
) -> Result<i64, String> {
    let paths: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT file_path FROM assets")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };

    let mut count: i64 = 0;
    for rel in paths {
        let src = assets_dir.join(&rel);
        if !src.exists() {
            return Err(format!("asset missing: {rel}"));
        }
        copy_file(&src, &dest.join("assets").join(&rel)).map_err(|e| e.to_string())?;
        count += 1;
    }
    Ok(count)
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

/// Removes validated snapshots beyond retention, oldest first. Unvalidated dirs
/// are left in place.
pub fn prune_old_backups(backup_root: &Path) {
    let validated = validated_backups(backup_root);
    if validated.len() <= BACKUP_RETENTION {
        return;
    }
    let to_remove = validated.len() - BACKUP_RETENTION;
    for v in validated.iter().take(to_remove) {
        if let Some(dir) = v.db.parent() {
            let _ = fs::remove_dir_all(dir);
        }
    }
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
    let Some(ts) = name.to_string_lossy().parse::<u64>().ok() else {
        return false;
    };
    now_secs().saturating_sub(ts) < RATE_LIMIT_SECONDS
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

    let Ok(conn) = Connection::open(db_path) else {
        return;
    };

    // Stage into a unique temp dir inside the backup root so a crash mid-snapshot
    // never leaves a half-written dir that could be mistaken for a valid one.
    let staging = backup_root.join(format!(".staging-{}", uuid::Uuid::now_v7()));
    if fs::create_dir_all(&staging).is_err() {
        return;
    }

    let result = (|| -> Result<(), String> {
        let dest_db = staging.join("workspace.sqlite3");
        backup_database(&conn, &dest_db).map_err(|e| e.to_string())?;

        // Re-open the staged copy to validate and read its asset list.
        let snap = Connection::open(&dest_db).map_err(|e| e.to_string())?;
        validate_snapshot(&snap)?;
        let asset_count = copy_referenced_assets(&snap, assets_dir, &staging)?;

        // Record a success manifest.
        let manifest = serde_json::json!({
            "timestamp_secs": now_secs(),
            "schema_version": schema_version(&conn),
            "asset_count": asset_count,
            "validation": "ok",
        });
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        fs::write(staging.join("manifest.json"), manifest_bytes).map_err(|e| e.to_string())?;

        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
        return;
    }

    // Atomic publish: rename the fully staged dir into its final timestamp name.
    let final_dir = backup_root.join(snapshot_dir_name());
    if fs::rename(&staging, &final_dir).is_ok() {
        prune_old_backups(backup_root);
    } else {
        let _ = fs::remove_dir_all(&staging);
    }
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
