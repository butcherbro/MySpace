//! The journal's storage and export API (ADR-0011 S1/S2).
//!
//! A transport asks a peer for [`changes_since`] its own cursors
//! ([`our_cursors`]) and hands the rows to `replay::apply_remote`. Cursors are
//! per origin device: the highest HLC held from that origin. Because rows are
//! always served in HLC order and an origin's HLCs only grow, what a device
//! holds from each origin is a prefix, so "everything above the cursor" is
//! exactly what is missing, whoever serves it (star and mesh topologies).
//! Compaction (`sync::compact`) takes superseded rows out of that prefix;
//! whoever received the rows that superseded them does not need them.

use std::collections::{BTreeMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::ChangeRow;
use crate::domain::errors::WorkspaceError;

/// Default and maximum page size of [`changes_since`].
pub const DEFAULT_PAGE: usize = 500;
pub const MAX_PAGE: usize = 5_000;

/// One page of an export. `next` is set when more rows remain: pass it back
/// as the cursors of the next call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePage {
    pub rows: Vec<ChangeRow>,
    pub next: Option<BTreeMap<String, String>>,
}

/// What `sync_status` reports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub device_id: String,
    pub cursors: BTreeMap<String, String>,
    pub pending_count: i64,
    pub missing_blobs: Vec<String>,
}

/// Stores a journal row; `false` when `(origin, hlc)` was already held.
pub fn insert_change(
    conn: &Connection,
    row: &ChangeRow,
    received_at: i64,
) -> Result<bool, WorkspaceError> {
    let inserted = conn
        .prepare_cached(
            "INSERT OR IGNORE INTO changes
                (origin_device_id, hlc, entity_kind, entity_id, op, payload_json, received_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?
        .execute(params![
            row.origin_device_id,
            row.hlc,
            row.entity_kind,
            row.entity_id,
            row.op,
            row.payload_json,
            received_at
        ])?;
    Ok(inserted > 0)
}

/// True when `changes` already holds `(origin, hlc)`.
pub fn holds(conn: &Connection, origin: &str, hlc: &str) -> Result<bool, WorkspaceError> {
    Ok(conn
        .prepare_cached("SELECT 1 FROM changes WHERE origin_device_id = ?1 AND hlc = ?2")?
        .query_row(params![origin, hlc], |_| Ok(()))
        .optional()?
        .is_some())
}

/// Raises the cursor of `origin` to `hlc` (never lowers it).
pub fn advance_cursor(conn: &Connection, origin: &str, hlc: &str) -> Result<(), WorkspaceError> {
    conn.prepare_cached(
        "INSERT INTO sync_cursors (peer_device_id, last_hlc) VALUES (?1, ?2)
         ON CONFLICT(peer_device_id) DO UPDATE SET last_hlc = MAX(last_hlc, excluded.last_hlc)",
    )?
    .execute(params![origin, hlc])?;
    Ok(())
}

/// The highest HLC held from `origin`, if any.
pub fn cursor(conn: &Connection, origin: &str) -> Result<Option<String>, WorkspaceError> {
    Ok(conn
        .prepare_cached("SELECT last_hlc FROM sync_cursors WHERE peer_device_id = ?1")?
        .query_row([origin], |r| r.get(0))
        .optional()?)
}

/// This device's vector clock: per origin device, the highest HLC held.
pub fn our_cursors(conn: &Connection) -> Result<BTreeMap<String, String>, WorkspaceError> {
    let mut stmt = conn.prepare("SELECT peer_device_id, last_hlc FROM sync_cursors")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The statements [`changes_since`] runs. Each must be an index search: a
/// test checks their plans.
const ORIGINS_SQL: &str = "WITH RECURSIVE origins(id) AS (
        SELECT MIN(origin_device_id) FROM changes
        UNION ALL
        SELECT (SELECT MIN(origin_device_id) FROM changes WHERE origin_device_id > origins.id)
        FROM origins WHERE origins.id IS NOT NULL
     )
     SELECT id FROM origins WHERE id IS NOT NULL";
const KEYS_ABOVE_SQL: &str = "SELECT hlc, seq FROM changes WHERE origin_device_id = ?1 AND hlc > ?2
     ORDER BY hlc LIMIT ?3";
const KEYS_ALL_SQL: &str =
    "SELECT hlc, seq FROM changes WHERE origin_device_id = ?1 ORDER BY hlc LIMIT ?2";
const ROW_BY_SEQ_SQL: &str =
    "SELECT origin_device_id, hlc, entity_kind, entity_id, op, payload_json
     FROM changes WHERE seq = ?1";

/// Origin devices with rows in `changes`: one seek per origin on the
/// `(origin_device_id, hlc)` index, whatever the journal's size.
pub(crate) fn origins(conn: &Connection) -> Result<Vec<String>, WorkspaceError> {
    let mut stmt = conn.prepare_cached(ORIGINS_SQL)?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Every row this device holds that the holder of `cursors` lacks: rows from
/// an origin absent from `cursors`, or above its value. HLC order, at most
/// `limit` rows (clamped to [`MAX_PAGE`]); `next` continues the export.
///
/// Per origin held here, the first `limit + 1` keys above its cursor come
/// from one index seek; the page is the smallest of them in `(hlc, seq)`
/// order, and only its rows are read. (One query with an `OR` per origin
/// cannot use that index: it walked the journal from its start.)
pub fn changes_since(
    conn: &Connection,
    cursors: &BTreeMap<String, String>,
    limit: usize,
) -> Result<ChangePage, WorkspaceError> {
    // One read snapshot across the statements below, as the single query had.
    // The guard rolls back on drop (an error or a panic), so a pooled reader
    // never goes back to the pool inside an open read transaction.
    let tx = conn.unchecked_transaction()?;
    let page = read_page(&tx, cursors, limit)?;
    tx.commit()?;
    Ok(page)
}

fn read_page(
    conn: &Connection,
    cursors: &BTreeMap<String, String>,
    limit: usize,
) -> Result<ChangePage, WorkspaceError> {
    let limit = limit.clamp(1, MAX_PAGE);
    let take = limit as i64 + 1;
    let mut keys: Vec<(String, i64)> = Vec::new();
    {
        let mut above = conn.prepare_cached(KEYS_ABOVE_SQL)?;
        let mut all = conn.prepare_cached(KEYS_ALL_SQL)?;
        for origin in origins(conn)? {
            let found: Vec<(String, i64)> = match cursors.get(&origin) {
                Some(hlc) => above
                    .query_map(params![origin, hlc, take], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<Result<_, _>>()?,
                None => all
                    .query_map(params![origin, take], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<Result<_, _>>()?,
            };
            keys.extend(found);
        }
    }
    keys.sort();
    keys.truncate(limit + 1);
    let mut by_seq = conn.prepare_cached(ROW_BY_SEQ_SQL)?;
    let mut rows: Vec<ChangeRow> = keys
        .iter()
        .map(|(_, seq)| {
            by_seq.query_row([seq], |r| {
                Ok(ChangeRow {
                    origin_device_id: r.get(0)?,
                    hlc: r.get(1)?,
                    entity_kind: r.get(2)?,
                    entity_id: r.get(3)?,
                    op: r.get(4)?,
                    payload_json: r.get(5)?,
                })
            })
        })
        .collect::<Result<_, _>>()?;
    let next = if rows.len() > limit {
        rows.truncate(limit);
        let mut next = cursors.clone();
        for row in &rows {
            let entry = next.entry(row.origin_device_id.clone()).or_default();
            if row.hlc > *entry {
                *entry = row.hlc.clone();
            }
        }
        Some(next)
    } else {
        None
    };
    Ok(ChangePage { rows, next })
}

/// Parks a received row whose dependency has not arrived yet.
pub fn park(conn: &Connection, row: &ChangeRow, received_at: i64) -> Result<(), WorkspaceError> {
    conn.execute(
        "INSERT INTO pending_changes
            (origin_device_id, hlc, entity_kind, entity_id, op, payload_json, received_at, attempts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)
         ON CONFLICT(origin_device_id, hlc) DO UPDATE SET attempts = attempts + 1",
        params![
            row.origin_device_id,
            row.hlc,
            row.entity_kind,
            row.entity_id,
            row.op,
            row.payload_json,
            received_at
        ],
    )?;
    Ok(())
}

/// Every pending row, in HLC order.
pub fn pending(conn: &Connection) -> Result<Vec<ChangeRow>, WorkspaceError> {
    let mut stmt = conn.prepare(
        "SELECT origin_device_id, hlc, entity_kind, entity_id, op, payload_json
         FROM pending_changes ORDER BY hlc",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ChangeRow {
            origin_device_id: r.get(0)?,
            hlc: r.get(1)?,
            entity_kind: r.get(2)?,
            entity_id: r.get(3)?,
            op: r.get(4)?,
            payload_json: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn pending_count(conn: &Connection) -> Result<i64, WorkspaceError> {
    Ok(conn.query_row("SELECT COUNT(*) FROM pending_changes", [], |r| r.get(0))?)
}

pub fn unpark(conn: &Connection, origin: &str, hlc: &str) -> Result<(), WorkspaceError> {
    conn.execute(
        "DELETE FROM pending_changes WHERE origin_device_id = ?1 AND hlc = ?2",
        params![origin, hlc],
    )?;
    Ok(())
}

pub fn bump_attempts(conn: &Connection, origin: &str, hlc: &str) -> Result<(), WorkspaceError> {
    conn.execute(
        "UPDATE pending_changes SET attempts = attempts + 1 WHERE origin_device_id = ?1 AND hlc = ?2",
        params![origin, hlc],
    )?;
    Ok(())
}

/// Content hashes of assets whose row is here but whose file is not (a
/// replayed asset whose blob a transport has yet to fetch). Distinct, sorted.
/// Legacy rows without a hash cannot be fetched by hash and are skipped.
pub fn missing_blobs(conn: &Connection, assets_dir: &Path) -> Result<Vec<String>, WorkspaceError> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT sha256, file_path FROM assets WHERE sha256 IS NOT NULL ORDER BY sha256",
    )?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    // One listing of the directory instead of one `stat` per asset. A name the
    // listing does not show as a regular file is still checked with `is_file`
    // (a symlink, a case-insensitive match), so the answer is the same.
    let listed: HashSet<OsString> = std::fs::read_dir(assets_dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
                .map(|e| e.file_name())
                .collect()
        })
        .unwrap_or_default();
    let mut missing: Vec<String> = rows
        .into_iter()
        .filter(|(_, file_path)| {
            !crate::is_safe_asset_name(file_path)
                || !(listed.contains(OsStr::new(file_path)) || assets_dir.join(file_path).is_file())
        })
        .map(|(sha, _)| sha)
        .collect();
    missing.dedup();
    Ok(missing)
}

/// Everything `sync_status` reports.
pub fn status(conn: &Connection, assets_dir: &Path) -> Result<SyncStatus, WorkspaceError> {
    Ok(SyncStatus {
        device_id: super::device_id(conn)?,
        cursors: our_cursors(conn)?,
        pending_count: pending_count(conn)?,
        missing_blobs: missing_blobs(conn, assets_dir)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The export stays an index seek however large the journal grows: no
    /// statement of `changes_since` may scan `changes`.
    #[test]
    fn changes_since_statements_search_an_index() {
        let conn = crate::db::open_in_memory().unwrap();
        for sql in [ORIGINS_SQL, KEYS_ABOVE_SQL, KEYS_ALL_SQL, ROW_BY_SEQ_SQL] {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            // Unbound parameters are NULL: the plan does not depend on them.
            let mut rows = stmt.raw_query();
            let mut plan: Vec<String> = Vec::new();
            while let Some(row) = rows.next().unwrap() {
                plan.push(row.get(3).unwrap());
            }
            // The table is the second word of a step; a bare `SCAN changes`
            // has nothing after it, so match the word, not a padded substring.
            let on_changes: Vec<&String> = plan
                .iter()
                .filter(|d| d.split_whitespace().nth(1) == Some("changes"))
                .collect();
            assert!(!on_changes.is_empty(), "{sql}: {plan:?}");
            assert!(
                on_changes
                    .iter()
                    .all(|d| d.starts_with("SEARCH changes USING")),
                "{sql}: {plan:?}"
            );
        }
    }
}
