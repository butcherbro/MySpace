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

use std::ops::Deref;

use rusqlite::{Connection, Savepoint, Transaction, TransactionBehavior};

/// A write transaction opened by [`immediate_tx`]: a real `BEGIN IMMEDIATE`
/// transaction when the connection is in autocommit mode, or a savepoint
/// nested in the caller's transaction otherwise.
///
/// The nesting is what lets the mutation funnel (ADR-0011, S1) wrap a whole
/// mutation in ONE outer `BEGIN IMMEDIATE` and append the change-journal rows
/// before its `COMMIT`: every repository function keeps opening "its"
/// transaction exactly as before, and inside the funnel that becomes a
/// savepoint. Called outside the funnel (tests, migrations), it is the
/// ordinary top-level transaction it always was.
///
/// Dropping it without [`WriteTx::commit`] rolls back (both variants).
pub enum WriteTx<'a> {
    Top(Transaction<'a>),
    Nested(Savepoint<'a>),
}

impl WriteTx<'_> {
    /// Commits the transaction, or releases the savepoint into the caller's.
    pub fn commit(self) -> rusqlite::Result<()> {
        match self {
            WriteTx::Top(tx) => tx.commit(),
            WriteTx::Nested(sp) => sp.commit(),
        }
    }
}

impl Deref for WriteTx<'_> {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        match self {
            WriteTx::Top(tx) => tx,
            WriteTx::Nested(sp) => sp,
        }
    }
}

/// Opens a write transaction with `BEGIN IMMEDIATE` (or a savepoint when the
/// connection is already inside one, see [`WriteTx`]).
///
/// Every write path must use this instead of `conn.transaction()` (DEFERRED).
/// In WAL mode a DEFERRED transaction that reads first and then writes can
/// fail with `SQLITE_BUSY` on the lock upgrade without honouring
/// `busy_timeout` when another process (the MCP server, a second app
/// instance) is writing. `BEGIN IMMEDIATE` takes the write lock up front and
/// waits up to `busy_timeout`, and it makes any guard query run inside the
/// transaction atomic with the write that depends on it. A nested savepoint
/// needs no lock of its own: the outer transaction is already IMMEDIATE.
pub fn immediate_tx(conn: &mut Connection) -> rusqlite::Result<WriteTx<'_>> {
    if conn.is_autocommit() {
        conn.transaction_with_behavior(TransactionBehavior::Immediate)
            .map(WriteTx::Top)
    } else {
        conn.savepoint().map(WriteTx::Nested)
    }
}
