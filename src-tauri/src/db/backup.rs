//! Startup backup: a consistent, recoverable snapshot of the workspace database
//! and its managed assets.
//!
//! The backup is intentionally minimal but correct: every launch (before any
//! migration or mutation) produces a plain, timestamped copy under
//! `backups/<timestamp>/`. The database copy uses SQLite's online backup API so
//! the result is transactionally consistent even while the live connection is in
//! WAL mode (`-wal`/`-shm` are folded in, never a half-written file). A bounded
//! number of recent snapshots are retained; older ones are removed.
//!
//! This is the recovery base layer — restoration is intentionally a manual
//! "copy the folder back" operation for V1, and can later grow a timer/UI
//! without changing the on-disk format.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

/// How many recent backup folders to keep. Oldest are deleted first.
const BACKUP_RETENTION: usize = 10;

/// Names a snapshot directory from the current wall-clock time. The format is
/// lexicographically sortable so "newest" and "oldest" are trivial to find.
fn snapshot_dir_name() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    // `secs` is sufficient uniqueness for a per-launch snapshot; sub-second
    // launches within one second are negligible for a recovery layer.
    format!("{}", now.as_secs())
}

/// Returns the ordered list of existing backup dirs (oldest -> newest) by name.
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

/// Writes a consistent SQLite backup of `src` to `dest`.
fn backup_database(src: &Connection, dest: &Path) -> Result<(), rusqlite::Error> {
    let mut dst = Connection::open(dest)?;
    {
        let backup = rusqlite::backup::Backup::new(src, &mut dst)?;
        backup.run_to_completion(100, std::time::Duration::from_millis(10), None)?;
    }
    // Fold the copy's own WAL into the main file so the snapshot is a single,
    // standalone .sqlite3 file that can be copied back verbatim.
    dst.execute_batch("PRAGMA journal_mode = DELETE; PRAGMA wal_checkpoint(TRUNCATE);")?;
    Ok(())
}

/// Copies the assets directory into the snapshot. Missing assets are not an
/// error: the database remains recoverable (cards simply lose their media
/// references until assets are restored separately).
fn copy_assets(assets_dir: &Path, dest: &Path) {
    if !assets_dir.exists() {
        return;
    }
    let _ = copy_dir_recursive(assets_dir, &dest.join("assets"));
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

/// Removes snapshots beyond `BACKUP_RETENTION`, oldest first. Failures to remove
/// a single stale dir are ignored (recovery is unaffected; a later run retries).
fn prune_old_backups(backup_root: &Path) {
    let dirs = existing_backups(backup_root);
    if dirs.len() <= BACKUP_RETENTION {
        return;
    }
    let to_remove = dirs.len() - BACKUP_RETENTION;
    for dir in dirs.iter().take(to_remove) {
        let _ = fs::remove_dir_all(dir);
    }
}

/// Performs a full startup snapshot. Never panics and never blocks startup: any
/// failure is logged-free no-op so a backup problem cannot prevent the app from
/// opening (the live database remains authoritative).
///
/// `db_path` is the live database file; `assets_dir` is the managed assets root;
/// `backup_root` is the `backups/` directory inside the app data dir.
pub fn snapshot_on_startup(db_path: &Path, assets_dir: &Path, backup_root: &Path) {
    // Never create a database where none exists yet: on a fresh install there is
    // nothing to back up, and opening a non-existent path would silently create
    // an empty file.
    if !db_path.exists() {
        return;
    }

    let Ok(conn) = Connection::open(db_path) else {
        return;
    };

    let dir_name = snapshot_dir_name();
    let dest_dir = backup_root.join(&dir_name);
    if fs::create_dir_all(&dest_dir).is_err() {
        return;
    }

    let dest_db = dest_dir.join("workspace.sqlite3");
    if backup_database(&conn, &dest_db).is_ok() {
        copy_assets(assets_dir, &dest_dir);
        prune_old_backups(backup_root);
    } else {
        // A failed snapshot must not leave a half-written folder behind.
        let _ = fs::remove_dir_all(&dest_dir);
    }
}
