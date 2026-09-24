//! The journaled write path: how the writer thread applies one [`Mutation`].
//!
//! Every mutation runs in ONE `BEGIN IMMEDIATE` transaction owned here; the
//! repository code inside opens savepoints (`repositories::immediate_tx`).
//! Before `COMMIT`, a journaled mutation's touched entities become `changes`
//! rows ([`tracking::flush`]), so a write and its journal rows commit or roll
//! back together, in whichever process made the write (the app, the MCP
//! server). Local-only mutations and replays are not journaled
//! ([`Mutation::is_journaled`]).
//!
//! Exception: the maintenance mutations (asset GC, hash backfill, favicon
//! collapse) interleave file I/O with many short transactions of their own
//! and must not hold the write lock for all of it
//! ([`Mutation::manages_own_transactions`]). What they changed is flushed in
//! a follow-up transaction: their only synced effects (an asset's `sha256`,
//! a canonical favicon id) are re-derivable, so the gap is harmless.

use rusqlite::Connection;

use super::image::Cause;
use super::tracking;
use crate::app::WorkspacePaths;
use crate::domain::errors::WorkspaceError;
use crate::domain::mutation::{Mutation, MutationOutcome};
use crate::repositories::immediate_tx;

fn cause(mutation: &Mutation) -> Cause {
    let (kind, id) = mutation.target();
    Cause {
        kind: kind.as_str().to_string(),
        id: id.to_string(),
    }
}

fn journal_or_clear(conn: &Connection, mutation: &Mutation) -> Result<(), WorkspaceError> {
    if mutation.is_journaled() {
        tracking::flush(conn, mutation.op_name(), Some(&cause(mutation)))?;
    } else {
        tracking::clear(conn)?;
    }
    Ok(())
}

fn execute_and_journal(
    conn: &mut Connection,
    mutation: &Mutation,
    paths: &WorkspacePaths,
) -> Result<MutationOutcome, WorkspaceError> {
    tracking::clear(conn)?;
    let outcome = mutation.execute(conn, paths)?;
    journal_or_clear(conn, mutation)?;
    Ok(outcome)
}

/// Applies `mutation` with its journal rows, atomically. `prepare` (e.g. the
/// pre-Empty-Trash backup) is the caller's job: it must not run inside the
/// transaction and must not be repeated by a busy retry.
pub fn apply(
    conn: &mut Connection,
    mutation: &Mutation,
    paths: &WorkspacePaths,
) -> Result<MutationOutcome, WorkspaceError> {
    tracking::ensure_installed(conn)?;

    if mutation.manages_own_transactions() {
        tracking::clear(conn)?;
        let outcome = mutation.execute(conn, paths);
        // Journal whatever committed, even when a later chunk failed.
        let tx = immediate_tx(conn)?;
        journal_or_clear(&tx, mutation)?;
        tx.commit()?;
        return outcome;
    }

    conn.execute_batch("BEGIN IMMEDIATE")?;
    match execute_and_journal(conn, mutation, paths) {
        Ok(outcome) => match conn.execute_batch("COMMIT") {
            Ok(()) => Ok(outcome),
            Err(err) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(err.into())
            }
        },
        Err(err) => {
            if !conn.is_autocommit() {
                let _ = conn.execute_batch("ROLLBACK");
            }
            Err(err)
        }
    }
}
