//! Database connection management and first-run bootstrap.
//!
//! SQLite is the authoritative store. Every connection opens with the V1
//! pragmas from Section C of the plan: foreign keys on, WAL journaling, FULL
//! synchronous, and a bounded busy timeout.

pub mod backup;
pub mod bootstrap;
pub mod migrations;

use rusqlite::{Connection, Error, Result};

use migrations::SchemaStatus;

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

/// Opens the database at `path` for a secondary process (e.g. the MCP
/// server) that must never migrate the workspace database out from under the
/// main app. Applies the standard pragmas, but if the schema is not already
/// fully up to date — either pending migrations this build would apply, or a
/// schema newer than this build understands — returns an error instead of
/// touching the schema.
pub fn open_readonly_checked(path: &std::path::Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    apply_pragmas(&conn)?;

    match migrations::schema_status(&conn)? {
        SchemaStatus::UpToDate => Ok(conn),
        SchemaStatus::Pending(count) => Err(Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
            Some(format!(
                "database schema has {count} pending migration(s); refusing to open without migrating (run the main MySpace app first)"
            )),
        )),
        SchemaStatus::Newer { db, app } => Err(Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
            Some(format!(
                "database schema version {db} is newer than this build supports ({app}); update MySpace"
            )),
        )),
    }
}

/// Opens (or creates) the database at `path`, applies pragmas and migrations,
/// then runs first-run bootstrap so exactly one workspace and Home root board
/// exist.
pub fn open_and_bootstrap(path: &std::path::Path) -> Result<Connection> {
    let mut conn = open(path)?;
    bootstrap::bootstrap(&mut conn)?;
    Ok(conn)
}
