//! Migration tests: the V1 schema must exist, be correct, and survive re-runs.

use myspace_lib::db::{migrations, open_in_memory};

fn table_names(conn: &rusqlite::Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap();
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).unwrap();
    rows.map(|r| r.unwrap()).collect()
}

fn index_names(conn: &rusqlite::Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
        .unwrap();
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).unwrap();
    rows.map(|r| r.unwrap()).collect()
}

#[test]
fn migration_creates_all_v1_tables() {
    let conn = open_in_memory().unwrap();
    let tables = table_names(&conn);

    for expected in [
        "workspaces",
        "boards",
        "cards",
        "note_cards",
        "board_portal_cards",
        "board_view_states",
        "schema_migrations",
    ] {
        assert!(
            tables.iter().any(|t| t == expected),
            "missing table: {expected}; got {tables:?}"
        );
    }
}

#[test]
fn migration_creates_all_v1_indexes() {
    let conn = open_in_memory().unwrap();
    let indexes = index_names(&conn);

    for expected in [
        "idx_boards_parent_active",
        "idx_cards_board_active",
        "idx_cards_trash_batch",
        "idx_boards_trash_batch",
    ] {
        assert!(
            indexes.iter().any(|t| t == expected),
            "missing index: {expected}; got {indexes:?}"
        );
    }
}

#[test]
fn foreign_keys_have_no_violations_on_empty_db() {
    let conn = open_in_memory().unwrap();
    let mut stmt = conn.prepare("PRAGMA foreign_key_check").unwrap();
    let count = stmt.query_map([], |_| Ok(())).unwrap().count();
    assert_eq!(count, 0);
}

#[test]
fn migrations_are_idempotent() {
    let mut conn = open_in_memory().unwrap();
    // Applying migrations again must be a no-op without error.
    migrations::run_migrations(&mut conn).unwrap();
    migrations::run_migrations(&mut conn).unwrap();
}

#[test]
fn migration_is_recorded_in_schema_migrations() {
    let conn = open_in_memory().unwrap();
    let mut stmt = conn
        .prepare("SELECT version, name FROM schema_migrations WHERE version = 1")
        .unwrap();
    let (version, name): (i64, String) = stmt
        .query_row([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap();
    assert_eq!(version, 1);
    assert_eq!(name, "workspace");
}
