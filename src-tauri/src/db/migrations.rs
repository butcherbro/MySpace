//! Versioned SQLite migrations.
//!
//! Each migration is embedded from `src-tauri/migrations/*.sql` and applied in
//! order inside a transaction. Applied versions are tracked in the
//! `schema_migrations` table so re-runs are idempotent.

use rusqlite::{ffi, Connection, Result, Transaction};

/// Builds a `rusqlite::Error` that carries `message`, for schema-guard
/// conditions that are not really SQLite errors but must flow through the
/// same `Result` type. `ModuleError` would fit better but requires the
/// `vtab` feature, which this crate does not enable, so a generic
/// `SqliteFailure` carries the message instead.
fn schema_error(message: String) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(ffi::Error::new(ffi::SQLITE_ERROR), Some(message))
}

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
    Migration {
        version: 8,
        name: "embed_description_origin",
        sql: include_str!("../../migrations/0008_embed_description_origin.sql"),
    },
    Migration {
        version: 9,
        name: "board_cover",
        sql: include_str!("../../migrations/0009_board_cover.sql"),
    },
    Migration {
        version: 10,
        name: "unsorted_cards",
        sql: include_str!("../../migrations/0010_unsorted_cards.sql"),
    },
    Migration {
        version: 11,
        name: "note_color",
        sql: include_str!("../../migrations/0011_note_color.sql"),
    },
    Migration {
        version: 12,
        name: "filesystem_aliases",
        sql: include_str!("../../migrations/0012_filesystem_aliases.sql"),
    },
    Migration {
        version: 13,
        name: "file_cards",
        sql: include_str!("../../migrations/0013_file_cards.sql"),
    },
    Migration {
        version: 14,
        name: "file_card_source_path",
        sql: include_str!("../../migrations/0014_file_card_source_path.sql"),
    },
    Migration {
        version: 15,
        name: "file_card_preview_asset",
        sql: include_str!("../../migrations/0015_file_card_preview_asset.sql"),
    },
    Migration {
        version: 16,
        name: "favicon_cache",
        sql: include_str!("../../migrations/0016_favicon_cache.sql"),
    },
    Migration {
        version: 17,
        name: "operation_receipts",
        sql: include_str!("../../migrations/0017_operation_receipts.sql"),
    },
    Migration {
        version: 18,
        name: "board_shortcuts",
        sql: include_str!("../../migrations/0018_board_shortcuts.sql"),
    },
    Migration {
        version: 19,
        name: "indexes",
        sql: include_str!("../../migrations/0019_indexes.sql"),
    },
];

/// The result of comparing the database's applied migrations against what
/// this build of the application knows about, without mutating anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaStatus {
    /// The database has every migration this build knows about applied, and
    /// nothing newer.
    UpToDate,
    /// The database is missing `count` migrations that this build would
    /// apply.
    Pending(usize),
    /// The database has applied a migration version newer than anything this
    /// build knows about. This build must not touch the database.
    Newer { db: i64, app: i64 },
}

/// Highest version number known to this build (0 if `MIGRATIONS` is empty).
fn max_app_version() -> i64 {
    MIGRATIONS.iter().map(|m| m.version).max().unwrap_or(0)
}

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
///
/// Refuses to run if the database already has a migration version applied
/// that is newer than anything this build knows about: an older build must
/// never mutate a database a newer build has already migrated.
pub fn run_migrations(conn: &mut Connection) -> Result<()> {
    ensure_migrations_table(conn)?;

    let applied = applied_versions(conn)?;
    let app_version = max_app_version();
    if let Some(&db_version) = applied.iter().max() {
        if db_version > app_version {
            return Err(schema_error(format!(
                "database schema version {db_version} is newer than this build supports ({app_version}); update MySpace"
            )));
        }
    }

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

        verify_schema_integrity(conn, migration.version)?;
    }

    Ok(())
}

/// Runs `PRAGMA foreign_key_check` and `PRAGMA quick_check` against `conn`
/// and fails, naming `version`, if either reports a problem. Called after
/// each migration commits (with foreign keys re-enabled) so a broken
/// migration is caught immediately rather than surfacing later as a mystery
/// data-integrity bug.
fn verify_schema_integrity(conn: &Connection, version: i64) -> Result<()> {
    let mut fk_stmt = conn.prepare("PRAGMA foreign_key_check;")?;
    let mut fk_rows = fk_stmt.query([])?;
    if fk_rows.next()?.is_some() {
        return Err(schema_error(format!(
            "migration {version} left dangling foreign keys (PRAGMA foreign_key_check found violations)"
        )));
    }

    let quick_check: String = conn.query_row("PRAGMA quick_check;", [], |row| row.get(0))?;
    if quick_check != "ok" {
        return Err(schema_error(format!(
            "migration {version} failed integrity check: PRAGMA quick_check reported '{quick_check}'"
        )));
    }

    Ok(())
}

/// Reports how the database's applied migrations compare to this build's
/// `MIGRATIONS`, without applying anything or creating the bookkeeping
/// table.
pub fn schema_status(conn: &Connection) -> Result<SchemaStatus> {
    let table_exists: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations')",
        [],
        |row| row.get(0),
    )?;

    let applied = if table_exists {
        applied_versions(conn)?
    } else {
        Vec::new()
    };

    let app_version = max_app_version();
    if let Some(&db_version) = applied.iter().max() {
        if db_version > app_version {
            return Ok(SchemaStatus::Newer {
                db: db_version,
                app: app_version,
            });
        }
    }

    let pending = MIGRATIONS
        .iter()
        .filter(|m| !applied.contains(&m.version))
        .count();

    if pending == 0 {
        Ok(SchemaStatus::UpToDate)
    } else {
        Ok(SchemaStatus::Pending(pending))
    }
}

/// Current UTC unix milliseconds.
pub fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
