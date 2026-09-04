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

/// Regression: applying migration 2 (which re-creates `cards`) over a database
/// that already contains note/board rows must not trip a FOREIGN KEY violation.
#[test]
fn migration_widens_cards_kind_without_fk_violation() {
    // Build a v1-only database (apply migration 1 by hand) with data, then run
    // the migration runner to apply v2 over it — exactly the real upgrade path.
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    conn.execute_batch(include_str!("../migrations/0001_workspace.sql"))
        .unwrap();
    conn.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'workspace', 0)",
        [],
    )
    .unwrap();

    // A workspace + home board so cards have a valid board_id FK.
    conn.execute(
        "INSERT INTO workspaces (id, title, root_board_id, created_at, updated_at) VALUES ('ws1', 'Home', 'home', 0, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO boards (id, workspace_id, parent_board_id, title, color_token, symbol, revision, created_at, updated_at) VALUES ('home', 'ws1', NULL, 'Home', 'default', NULL, 1, 0, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at) VALUES ('c1', 'home', 'note', 0, 0, 200, 80, 0, 1, 0, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO note_cards (card_id, document_json, plain_text) VALUES ('c1', '{\"type\":\"doc\"}', '')",
        [],
    )
    .unwrap();

    // Applying migration 2 over these rows must succeed (previously hit
    // FOREIGN KEY constraint failed).
    migrations::run_migrations(&mut conn).unwrap();

    // The note survived, and the new image/embed kind is now accepted.
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM cards WHERE id = 'c1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(count, 1);

    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at) VALUES ('c2', 'home', 'image', 0, 0, 200, 80, 0, 1, 0, 0)",
        [],
    )
    .unwrap();

    let mut stmt = conn.prepare("PRAGMA foreign_key_check").unwrap();
    let violations = stmt.query_map([], |_| Ok(())).unwrap().count();
    assert_eq!(violations, 0);
}
