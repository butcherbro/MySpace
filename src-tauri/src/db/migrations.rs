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
    Migration {
        version: 3,
        name: "embed_links",
        sql: include_str!("../../migrations/0003_embed_links.sql"),
    },
    Migration {
        version: 4,
        name: "top_left_board_origin",
        sql: include_str!("../../migrations/0004_top_left_board_origin.sql"),
    },
    Migration {
        version: 5,
        name: "mutation_idempotency",
        sql: include_str!("../../migrations/0005_mutation_idempotency.sql"),
    },
    Migration {
        version: 6,
        name: "mutation_receipts_card_ids",
        sql: include_str!("../../migrations/0006_mutation_receipts_card_ids.sql"),
    },
    Migration {
        version: 7,
        name: "quick_boards",
        sql: include_str!("../../migrations/0007_quick_boards.sql"),
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

/// Applies any pending migrations. Foreign keys are temporarily disabled on
/// the connection (outside any transaction, where the pragma actually takes
/// effect) so no-op table-recreation migrations (e.g. widening a CHECK) can drop
/// and rebuild `cards` without tripping `FOREIGN KEY` from child tables.
pub fn run_migrations(conn: &mut Connection) -> Result<()> {
    ensure_migrations_table(conn)?;

    let applied = applied_versions(conn)?;

    for migration in MIGRATIONS {
        if applied.contains(&migration.version) {
            continue;
        }

        // `PRAGMA foreign_keys` is a no-op inside a transaction, so it must be
        // set here, before the migration's own transaction begins.
        conn.execute_batch("PRAGMA foreign_keys = OFF;")?;

        let tx: Transaction = conn.transaction()?;
        tx.execute_batch(migration.sql)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![migration.version, migration.name, now_millis(),],
        )?;
        tx.commit()?;

        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
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
