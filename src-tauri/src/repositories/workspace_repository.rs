//! Repository for reading board snapshots and creating notes.
//!
//! SQLite is authoritative (ADR-003). These functions are the only place that
//! maps database rows to domain DTOs and back.

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use crate::domain::errors::WorkspaceError;

// Quick Boards live in their own aggregate module; re-exported so every existing
// `workspace_repository::…` path keeps working.
pub use super::assets::*;
pub use super::boards::*;
pub use super::cards::*;
pub use super::move_selection::*;
pub use super::quick_boards::*;
pub use super::search::*;

/// A stored receipt for an operation that changed several aggregates (ADR-0007).
pub struct StoredReceipt {
    pub operation_id: String,
    pub request_fingerprint: String,
    pub receipt_json: String,
}

/// Looks a receipt up by its idempotency key. A hit means the operation already
/// committed, so the caller returns the original receipt instead of replaying the
/// move against revisions that are now stale.
pub fn find_operation_receipt(
    conn: &Connection,
    operation_kind: &str,
    idempotency_key: &str,
) -> Result<Option<StoredReceipt>, WorkspaceError> {
    conn.query_row(
        "SELECT operation_id, request_fingerprint, receipt_json FROM operation_receipts
         WHERE operation_kind = ?1 AND idempotency_key = ?2",
        params![operation_kind, idempotency_key],
        |row| {
            Ok(StoredReceipt {
                operation_id: row.get(0)?,
                request_fingerprint: row.get(1)?,
                receipt_json: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(WorkspaceError::from)
}

/// Stores a receipt inside the caller's transaction, so the receipt and the
/// aggregates it describes commit or roll back together (ADR-0007 rule 5).
#[allow(clippy::too_many_arguments)]
pub fn store_operation_receipt(
    tx: &Transaction<'_>,
    operation_id: &str,
    operation_kind: &str,
    idempotency_key: &str,
    request_fingerprint: &str,
    receipt_json: &str,
    created_at: i64,
) -> Result<(), WorkspaceError> {
    tx.execute(
        "INSERT INTO operation_receipts (operation_id, operation_kind, idempotency_key, request_fingerprint, receipt_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            operation_id,
            operation_kind,
            idempotency_key,
            request_fingerprint,
            receipt_json,
            created_at
        ],
    )?;
    Ok(())
}
