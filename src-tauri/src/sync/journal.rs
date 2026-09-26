//! The journal's storage and export API (ADR-0011 S1/S2).
//!
//! A transport asks a peer for [`changes_since`] its own cursors
//! ([`our_cursors`]) and hands the rows to `replay::apply_remote`. Cursors are
//! per origin device: the highest HLC held from that origin. Because rows are
//! always served in HLC order and an origin's HLCs only grow, what a device
//! holds from each origin is a prefix, so "everything above the cursor" is
//! exactly what is missing, whoever serves it (star and mesh topologies).

use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
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

/// This device's vector clock: per origin device, the highest HLC held.
pub fn our_cursors(conn: &Connection) -> Result<BTreeMap<String, String>, WorkspaceError> {
    let mut stmt = conn.prepare("SELECT peer_device_id, last_hlc FROM sync_cursors")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Every row this device holds that the holder of `cursors` lacks: rows from
/// an origin absent from `cursors`, or above its value. HLC order, at most
/// `limit` rows (clamped to [`MAX_PAGE`]); `next` continues the export.
pub fn changes_since(
    conn: &Connection,
    cursors: &BTreeMap<String, String>,
    limit: usize,
) -> Result<ChangePage, WorkspaceError> {
    let limit = limit.clamp(1, MAX_PAGE);
    let mut clauses = Vec::with_capacity(cursors.len() + 1);
    let mut values: Vec<SqlValue> = Vec::with_capacity(cursors.len() * 3);
    if cursors.is_empty() {
        clauses.push("1".to_string());
    } else {
        let known = vec!["?"; cursors.len()].join(", ");
        clauses.push(format!("origin_device_id NOT IN ({known})"));
        values.extend(cursors.keys().map(|k| SqlValue::Text(k.clone())));
        for (origin, hlc) in cursors {
            clauses.push("(origin_device_id = ? AND hlc > ?)".to_string());
            values.push(SqlValue::Text(origin.clone()));
            values.push(SqlValue::Text(hlc.clone()));
        }
    }
    values.push(SqlValue::Integer(limit as i64 + 1));
    let sql = format!(
        "SELECT origin_device_id, hlc, entity_kind, entity_id, op, payload_json
         FROM changes WHERE {} ORDER BY hlc, seq LIMIT ?",
        clauses.join(" OR ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows: Vec<ChangeRow> = stmt
        .query_map(params_from_iter(values.iter()), |r| {
            Ok(ChangeRow {
                origin_device_id: r.get(0)?,
                hlc: r.get(1)?,
                entity_kind: r.get(2)?,
                entity_id: r.get(3)?,
                op: r.get(4)?,
                payload_json: r.get(5)?,
            })
        })?
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
    let mut missing: Vec<String> = rows
        .into_iter()
        .filter(|(_, file_path)| {
            !crate::is_safe_asset_name(file_path) || !assets_dir.join(file_path).is_file()
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
