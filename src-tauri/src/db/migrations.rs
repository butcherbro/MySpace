//! Versioned SQLite migrations.
//!
//! Each migration is embedded from `src-tauri/migrations/*.sql` and applied in
//! order inside a transaction. Applied versions are tracked in the
//! `schema_migrations` table so re-runs are idempotent.

use rusqlite::{Connection, Result, Transaction};

/// One migration: a version number and the SQL to apply.
pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

/// The ordered list of migrations. Keep this list append-only.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "workspace",
        sql: include_str!("../../migrations/0001_workspace.sql"),
    },
    Migration {
        version: 2,
        name: "assets",
        sql: include_str!("../../migrations/0002_assets.sql"),
    },
];

/// Creates the `schema_migrations` bookkeeping table if it does not yet exist.
fn ensure_migrations_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );",
    )
}

/// Returns the versions that have already been applied.
fn applied_versions(conn: &Connection) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare("SELECT version FROM schema_migrations ORDER BY version")?;
    let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
    rows.collect()
}

/// Applies any pending migrations in a single transaction.
pub fn run_migrations(conn: &mut Connection) -> Result<()> {
    ensure_migrations_table(conn)?;

    let applied = applied_versions(conn)?;

    for migration in MIGRATIONS {
        if applied.contains(&migration.version) {
            continue;
        }

        let tx: Transaction = conn.transaction()?;
        tx.execute_batch(migration.sql)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![migration.version, migration.name, now_millis(),],
        )?;
        tx.commit()?;
    }

    Ok(())
}

/// Current UTC unix milliseconds.
pub fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
