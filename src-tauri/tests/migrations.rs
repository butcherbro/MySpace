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

#[test]
fn filesystem_alias_migration_adds_detail_table_and_kind_without_fk_debt() {
    let conn = open_in_memory().unwrap();
    assert!(table_names(&conn)
        .iter()
        .any(|name| name == "filesystem_aliases"));
    conn.execute(
        "INSERT INTO workspaces (id, title, root_board_id, created_at, updated_at) VALUES ('alias-ws', 'Home', 'alias-home', 0, 0)",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO boards (id, workspace_id, parent_board_id, title, color_token, symbol, revision, created_at, updated_at) VALUES ('alias-home', 'alias-ws', NULL, 'Home', 'default', NULL, 1, 0, 0)",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, unsorted, created_at, updated_at) VALUES ('alias-card', 'alias-home', 'filesystem_alias', 1, 2, 280, 180, 3, 7, 1, 0, 0)",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO filesystem_aliases (card_id, target_kind, locator_blob, path_hint, display_name) VALUES ('alias-card', 'folder', X'0102', '/display-only', 'Folder')",
        [],
    ).unwrap();
    let preserved: (i64, i64) = conn
        .query_row(
            "SELECT revision, unsorted FROM cards WHERE id = 'alias-card'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(preserved, (7, 1));
    assert_eq!(
        conn.prepare("PRAGMA foreign_key_check")
            .unwrap()
            .query_map([], |_| Ok(()))
            .unwrap()
            .count(),
        0
    );
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

/// Existing V1 boards could contain negative coordinates because the canvas
/// used to be unbounded. The top-left boundary must rebase each board as one
/// rigid layout so no card becomes unreachable and relative spacing survives.
#[test]
fn migration_rebases_existing_board_layouts_to_non_negative_coordinates() {
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
    conn.execute_batch(include_str!("../migrations/0001_workspace.sql"))
        .unwrap();
    conn.execute_batch(include_str!("../migrations/0002_assets.sql"))
        .unwrap();
    conn.execute_batch(include_str!("../migrations/0003_embed_links.sql"))
        .unwrap();
    conn.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
         INSERT INTO schema_migrations (version, name, applied_at) VALUES
             (1, 'workspace', 0), (2, 'assets', 0), (3, 'embed_links', 0);
         INSERT INTO workspaces (id, title, root_board_id, created_at, updated_at)
             VALUES ('ws1', 'Home', 'home', 0, 0);
         INSERT INTO boards (id, workspace_id, parent_board_id, title, color_token, symbol, revision, created_at, updated_at)
             VALUES
             ('home', 'ws1', NULL, 'Home', 'default', NULL, 1, 0, 0),
             ('child', 'ws1', 'home', 'Child', 'default', NULL, 1, 0, 0);
         INSERT INTO board_view_states (board_id, viewport_x, viewport_y, zoom, revision, updated_at)
             VALUES ('home', 250, -80, 1.5, 7, 0);
         INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at, deleted_at)
             VALUES
             ('a', 'home', 'note', -10, 20, 200, 80, 0, 1, 0, 0, NULL),
             ('b', 'home', 'note', 30, -5, 200, 80, 1, 1, 0, 0, NULL),
             ('trash', 'home', 'note', -100, -40, 200, 80, 2, 1, 0, 0, 1),
             ('c', 'child', 'note', 12, 13, 200, 80, 0, 1, 0, 0, NULL);",
    )
    .unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();

    migrations::run_migrations(&mut conn).unwrap();

    let frames: Vec<(String, f64, f64)> = {
        let mut stmt = conn
            .prepare("SELECT id, x, y FROM cards ORDER BY id")
            .unwrap();
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    assert_eq!(
        frames,
        vec![
            ("a".to_string(), 90.0, 60.0),
            ("b".to_string(), 130.0, 35.0),
            ("c".to_string(), 12.0, 13.0),
            ("trash".to_string(), 0.0, 0.0),
        ]
    );

    let viewport: (f64, f64, f64, i64) = conn
        .query_row(
            "SELECT viewport_x, viewport_y, zoom, revision FROM board_view_states WHERE board_id = 'home'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(viewport, (0.0, 0.0, 1.5, 7));
}

#[test]
fn migration_creates_filesystem_aliases_table() {
    let conn = open_in_memory().unwrap();
    let tables = table_names(&conn);
    assert!(
        tables.iter().any(|t| t == "filesystem_aliases"),
        "missing filesystem_aliases table; got {tables:?}"
    );
}

#[test]
fn cards_accept_filesystem_alias_kind_and_foreign_keys_stay_clean() {
    let conn = open_in_memory().unwrap();
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
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at) VALUES ('fa1', 'home', 'filesystem_alias', 0, 0, 280, 180, 0, 1, 0, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO filesystem_aliases (card_id, target_kind, locator_blob, path_hint, display_name) VALUES ('fa1', 'folder', X'0102', '/tmp/demo', 'demo')",
        [],
    )
    .unwrap();

    let mut stmt = conn.prepare("PRAGMA foreign_key_check").unwrap();
    let violations = stmt.query_map([], |_| Ok(())).unwrap().count();
    assert_eq!(violations, 0);
}

#[test]
fn migration_creates_file_cards_table() {
    let conn = open_in_memory().unwrap();
    let tables = table_names(&conn);
    assert!(
        tables.iter().any(|t| t == "file_cards"),
        "missing file_cards table; got {tables:?}"
    );
}

#[test]
fn cards_accept_file_kind_and_foreign_keys_stay_clean() {
    let conn = open_in_memory().unwrap();
    conn.execute(
        "INSERT INTO workspaces (id, title, root_board_id, created_at, updated_at) VALUES ('ws2', 'Home', 'home2', 0, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO boards (id, workspace_id, parent_board_id, title, color_token, symbol, revision, created_at, updated_at) VALUES ('home2', 'ws2', NULL, 'Home', 'default', NULL, 1, 0, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at) VALUES ('a1', 'a1.txt', 'text/plain', 'a1.txt', NULL, NULL, 0, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at) VALUES ('fc1', 'home2', 'file', 0, 0, 280, 180, 0, 1, 0, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO file_cards (card_id, asset_id, mime_type, preview_text) VALUES ('fc1', 'a1', 'text/plain', 'hello')",
        [],
    )
    .unwrap();

    let mut stmt = conn.prepare("PRAGMA foreign_key_check").unwrap();
    let violations = stmt.query_map([], |_| Ok(())).unwrap().count();
    assert_eq!(violations, 0);
}

#[test]
fn migration_creates_the_0019_lookup_indexes() {
    let conn = open_in_memory().unwrap();
    let indexes = index_names(&conn);

    for expected in [
        "idx_image_cards_asset",
        "idx_embed_cards_asset",
        "idx_embed_cards_favicon_asset",
        "idx_file_cards_asset",
        "idx_file_cards_preview_asset",
        "idx_boards_cover_asset",
        "idx_favicon_cache_asset",
        "idx_mutation_receipts_batch",
        "idx_cards_trashed",
        "idx_boards_trashed",
    ] {
        assert!(
            indexes.iter().any(|t| t == expected),
            "missing index: {expected}; got {indexes:?}"
        );
    }
}

/// A database that already has a migration version newer than this build
/// knows about must never be migrated by an older build.
#[test]
fn run_migrations_refuses_a_database_newer_than_this_build() {
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    migrations::run_migrations(&mut conn).unwrap();

    conn.execute(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (9999, 'from_the_future', 0)",
        [],
    )
    .unwrap();

    let err = migrations::run_migrations(&mut conn).unwrap_err();
    let message = err.to_string();
    assert!(
        message.contains("newer"),
        "expected error message to mention 'newer', got: {message}"
    );
}

#[test]
fn schema_status_is_up_to_date_after_open_in_memory() {
    let conn = open_in_memory().unwrap();
    assert_eq!(
        migrations::schema_status(&conn).unwrap(),
        migrations::SchemaStatus::UpToDate
    );
}

#[test]
fn schema_status_reports_newer_without_mutating() {
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    migrations::run_migrations(&mut conn).unwrap();
    conn.execute(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (9999, 'from_the_future', 0)",
        [],
    )
    .unwrap();

    match migrations::schema_status(&conn).unwrap() {
        migrations::SchemaStatus::Newer { db, .. } => assert_eq!(db, 9999),
        other => panic!("expected SchemaStatus::Newer, got {other:?}"),
    }
}

#[test]
fn schema_status_reports_pending_before_migrating() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    conn.execute_batch(include_str!("../migrations/0001_workspace.sql"))
        .unwrap();
    conn.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
         INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'workspace', 0);",
    )
    .unwrap();

    match migrations::schema_status(&conn).unwrap() {
        migrations::SchemaStatus::Pending(count) => assert!(count > 0),
        other => panic!("expected SchemaStatus::Pending, got {other:?}"),
    }
}

/// Migration 0021 is the last `cards` rebuild: the kind and frame-size CHECKs
/// are gone (the guard is Rust: `CardKind`, `Frame::validate`), every other
/// constraint and every index on `cards` survives, and existing rows carry over.
#[test]
fn migration_0021_drops_the_kind_check_and_keeps_every_cards_index() {
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    // Apply 1..=20 by hand-picking the runner's list, seed data, then run 21.
    conn.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);",
    )
    .unwrap();
    for migration in migrations::MIGRATIONS.iter().filter(|m| m.version < 21) {
        conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
        conn.execute_batch(migration.sql).unwrap();
        conn.execute(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, 0)",
            rusqlite::params![migration.version, migration.name],
        )
        .unwrap();
    }
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    conn.execute(
        "INSERT INTO workspaces (id, title, root_board_id, created_at, updated_at) VALUES ('ws', 'Home', 'home', 0, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO boards (id, workspace_id, parent_board_id, title, color_token, symbol, revision, created_at, updated_at) VALUES ('home', 'ws', NULL, 'Home', 'default', NULL, 1, 0, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at, deleted_at, trash_batch_id, unsorted)
         VALUES ('old', 'home', 'note', 1.5, 2.5, 200, 80, 4, 9, 11, 12, 13, 'batch', 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO note_cards (card_id, document_json, plain_text) VALUES ('old', '{}', 'kept')",
        [],
    )
    .unwrap();
    // Before 0021 the CHECK still rejects an unknown kind.
    assert!(conn
        .execute(
            "INSERT INTO cards (id, board_id, kind, x, y, width, height, created_at, updated_at) VALUES ('pre', 'home', 'test_kind', 0, 0, 200, 80, 0, 0)",
            [],
        )
        .is_err());

    migrations::run_migrations(&mut conn).unwrap();

    let row: (String, f64, f64, i64, i64, Option<i64>, Option<String>, i64) = conn
        .query_row(
            "SELECT kind, x, y, z_index, revision, deleted_at, trash_batch_id, unsorted FROM cards WHERE id = 'old'",
            [],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        row,
        (
            "note".to_string(),
            1.5,
            2.5,
            4,
            9,
            Some(13),
            Some("batch".to_string()),
            1
        )
    );

    // The guard is Rust now: SQL accepts a new kind and any size.
    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, created_at, updated_at) VALUES ('new', 'home', 'test_kind', 0, 0, 5, 5, 0, 0)",
        [],
    )
    .unwrap();
    // Other constraints survive: the board FK, NOT NULL and the unsorted CHECK.
    assert!(conn
        .execute(
            "INSERT INTO cards (id, board_id, kind, x, y, width, height, created_at, updated_at) VALUES ('fk', 'nowhere', 'note', 0, 0, 200, 80, 0, 0)",
            [],
        )
        .is_err());
    assert!(conn
        .execute(
            "INSERT INTO cards (id, board_id, kind, x, y, width, height, created_at, updated_at, unsorted) VALUES ('u', 'home', 'note', 0, 0, 200, 80, 0, 0, 2)",
            [],
        )
        .is_err());
    assert!(conn
        .execute(
            "INSERT INTO cards (id, board_id, x, y, width, height, created_at, updated_at) VALUES ('k', 'home', 0, 0, 200, 80, 0, 0)",
            [],
        )
        .is_err());

    let mut stmt = conn.prepare("PRAGMA index_list(cards)").unwrap();
    let mut indexes: Vec<(String, bool)> = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(1)?, r.get::<_, i64>(4)? == 1))
        })
        .unwrap()
        .map(|r| r.unwrap())
        .filter(|(name, _)| !name.starts_with("sqlite_autoindex"))
        .collect();
    indexes.sort();
    assert_eq!(
        indexes,
        vec![
            ("idx_cards_board_active".to_string(), false),
            ("idx_cards_trash_batch".to_string(), false),
            ("idx_cards_trashed".to_string(), true),
        ],
        "(name, partial) of every index on cards"
    );

    let violations = conn
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .query_map([], |_| Ok(()))
        .unwrap()
        .count();
    assert_eq!(violations, 0);
}

#[test]
fn migration_0020_adds_asset_sha256_and_its_partial_index() {
    let conn = open_in_memory().unwrap();
    let columns: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('assets')")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert!(
        columns.iter().any(|c| c == "sha256"),
        "assets.sha256 missing; got {columns:?}"
    );

    let index_sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_assets_sha256'",
            [],
            |r| r.get(0),
        )
        .expect("idx_assets_sha256 exists");
    assert!(
        index_sql.contains("WHERE sha256 IS NOT NULL"),
        "{index_sql}"
    );

    let recorded: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = 20 AND name = 'asset_sha256'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(recorded, 1);
}

#[test]
fn migration_0022_creates_search_index_and_backfills_existing_rows() {
    assert!(
        migrations::MIGRATIONS
            .iter()
            .any(|m| m.version == 22 && m.name == "search_index"),
        "migration 0022 is registered"
    );

    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);",
    )
    .unwrap();
    for migration in migrations::MIGRATIONS.iter().filter(|m| m.version < 22) {
        conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
        conn.execute_batch(migration.sql).unwrap();
        conn.execute(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, 0)",
            rusqlite::params![migration.version, migration.name],
        )
        .unwrap();
    }
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    conn.execute_batch(
        "INSERT INTO workspaces (id, title, root_board_id, created_at, updated_at) VALUES ('ws', 'Home', 'home', 0, 0);
         INSERT INTO boards (id, workspace_id, parent_board_id, title, color_token, symbol, revision, created_at, updated_at)
             VALUES ('home', 'ws', NULL, 'Home', 'default', NULL, 1, 0, 0);
         INSERT INTO cards (id, board_id, kind, x, y, width, height, created_at, updated_at)
             VALUES ('n1', 'home', 'note', 0, 0, 200, 80, 0, 0),
                    ('n2', 'home', 'note', 0, 0, 200, 80, 0, 0),
                    ('e1', 'home', 'embed', 0, 0, 200, 80, 0, 0),
                    ('fa1', 'home', 'filesystem_alias', 0, 0, 200, 80, 0, 0);
         UPDATE cards SET deleted_at = 5 WHERE id = 'n2';
         INSERT INTO note_cards (card_id, document_json, plain_text) VALUES ('n1', '{}', 'Legacy galaxy note'), ('n2', '{}', 'Trashed galaxy');
         INSERT INTO embed_cards (card_id, source_url, display_url, title, description_plain_text)
             VALUES ('e1', 'https://example.com/a', 'example.com/a', 'Galaxy link', 'about stars');
         INSERT INTO filesystem_aliases (card_id, target_kind, locator_blob, path_hint, display_name)
             VALUES ('fa1', 'folder', x'00', '/Volumes/Galaxy', 'Footage');",
    )
    .unwrap();

    migrations::run_migrations(&mut conn).unwrap();

    let indexed: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare("SELECT entity_id, kind FROM search_index ORDER BY entity_id")
            .unwrap();
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        rows.map(|r| r.unwrap()).collect()
    };
    assert_eq!(
        indexed,
        vec![
            ("e1".to_string(), "embed".to_string()),
            ("fa1".to_string(), "filesystem_alias".to_string()),
            ("home".to_string(), "board".to_string()),
            ("n1".to_string(), "note".to_string()),
            ("n2".to_string(), "note".to_string()),
        ],
        "every pre-existing searchable row is indexed, trashed ones included"
    );

    let matched: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM search_index WHERE search_index MATCH '\"galax\"*'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(matched, 4, "n1, n2, e1 (title) and fa1 (path hint)");

    // Search itself excludes the trashed note at query time.
    let ids: Vec<String> =
        myspace_lib::repositories::workspace_repository::search_workspace(&conn, "galaxy")
            .unwrap()
            .into_iter()
            .map(|r| r.entity_id)
            .collect();
    assert_eq!(ids.len(), 3);
    assert!(!ids.contains(&"n2".to_string()));
}
