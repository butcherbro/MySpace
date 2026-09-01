//! Database connection management and first-run bootstrap.
//!
//! SQLite is the authoritative store. Every connection opens with the V1
//! pragmas from Section C of the plan: foreign keys on, WAL journaling, FULL
//! synchronous, and a bounded busy timeout.

pub mod bootstrap;
pub mod migrations;

use rusqlite::{Connection, Result};

/// Applies the V1 connection pragmas.
pub fn apply_pragmas(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         PRAGMA busy_timeout = 5000;",
    )
}

/// Opens an in-memory database, applies pragmas and migrations. Used by tests
/// and as the base for first-run setup.
pub fn open_in_memory() -> Result<Connection> {
    let mut conn = Connection::open_in_memory()?;
    apply_pragmas(&conn)?;
    migrations::run_migrations(&mut conn)?;
    Ok(conn)
}

/// Opens a database at `path`, creating it if necessary, then applies pragmas
/// and migrations.
pub fn open(path: &std::path::Path) -> Result<Connection> {
    let mut conn = Connection::open(path)?;
    apply_pragmas(&conn)?;
    migrations::run_migrations(&mut conn)?;
    Ok(conn)
}

/// Opens (or creates) the database at `path`, applies pragmas and migrations,
/// then runs first-run bootstrap so exactly one workspace and Home root board
/// exist.
pub fn open_and_bootstrap(path: &std::path::Path) -> Result<Connection> {
    let mut conn = open(path)?;
    bootstrap::bootstrap(&mut conn)?;
    Ok(conn)
}
