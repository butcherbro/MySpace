//! One-time journal backfill (migration 0025's data step).
//!
//! Data created before the journal existed has no `changes` rows, so a peer
//! could never learn about it. [`ensure_journal_snapshot`] emits, once per
//! database, a synthetic row for every synced entity with this device as
//! origin and a fresh HLC, in dependency order (boards parent-first, assets,
//! cards, quick-board references): exactly what `tracking::flush` writes for
//! a write that touched everything. Trashed boards and cards are included, so
//! a later restore or Empty Trash on any device has something to act on.
//!
//! Not part of the snapshot (never synced): everything in
//! `LOCAL_ONLY_TABLES`, `workspaces`, `favicon_cache`, the idempotency
//! receipts, the search index and `change_seq`.
//!
//! It runs at startup (`db::open_and_bootstrap`) rather than inside the
//! migration because it needs the final device identity, which the
//! fingerprint check after the migrations may still rotate (ADR-0012).
//! Guarded by `local_meta.journal_snapshot_done`, in the caller's transaction.

use rusqlite::{params, Connection, OptionalExtension};

use super::{tracking, OP_SNAPSHOT};
use crate::domain::errors::WorkspaceError;

/// `local_meta` key set once the backfill ran.
pub const SNAPSHOT_DONE_KEY: &str = "journal_snapshot_done";

/// Emits the backfill rows unless already done. Returns the rows written.
pub fn ensure_journal_snapshot(conn: &Connection) -> Result<usize, WorkspaceError> {
    let done: Option<String> = conn
        .query_row(
            "SELECT value FROM local_meta WHERE key = ?1",
            [SNAPSHOT_DONE_KEY],
            |r| r.get(0),
        )
        .optional()?;
    if done.is_some() {
        return Ok(0);
    }
    tracking::ensure_installed(conn)?;
    tracking::clear(conn)?;
    tracking::mark_everything(conn)?;
    let written = tracking::flush(conn, OP_SNAPSHOT, None)?.len();
    conn.execute(
        "INSERT INTO local_meta (key, value) VALUES (?1, ?2)",
        params![
            SNAPSHOT_DONE_KEY,
            crate::db::migrations::now_millis().to_string()
        ],
    )?;
    Ok(written)
}
