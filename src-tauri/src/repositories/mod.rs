//! Repository layer: the only place that maps DB rows to domain DTOs.

pub mod assets;
pub mod board_shortcuts;
pub mod boards;
pub mod cards;
pub mod devices;
pub mod move_selection;
pub mod quick_boards;
pub mod receipts;
pub mod search;
pub mod workspace_repository;

use rusqlite::{Connection, Transaction, TransactionBehavior};

/// Opens a write transaction with `BEGIN IMMEDIATE`.
///
/// Every write path must use this instead of `conn.transaction()` (DEFERRED).
/// In WAL mode a DEFERRED transaction that reads first and then writes can
/// fail with `SQLITE_BUSY` on the lock upgrade without honouring
/// `busy_timeout` when another process (the MCP server, a second app
/// instance) is writing. `BEGIN IMMEDIATE` takes the write lock up front and
/// waits up to `busy_timeout`, and it makes any guard query run inside the
/// transaction atomic with the write that depends on it.
pub fn immediate_tx(conn: &mut Connection) -> rusqlite::Result<Transaction<'_>> {
    conn.transaction_with_behavior(TransactionBehavior::Immediate)
}
