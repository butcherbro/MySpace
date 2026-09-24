//! ADR-0012: device identity, migration 0024 and device-scoped shortcut
//! locators.

use myspace_lib::app::WorkspacePaths;
use myspace_lib::db::{bootstrap, migrations, open_in_memory};
use myspace_lib::domain::card_kind::{CardKind, CopyContext};
use myspace_lib::domain::kinds::handler;
use myspace_lib::domain::models::{
    CardDto, CreateFilesystemAliasInput, FilesystemAliasDto, Frame, TrashItem, TrashSelectionInput,
    UpdateViewportInput,
};
use myspace_lib::domain::mutation::{Mutation, LOCAL_ONLY_TABLES};
use myspace_lib::domain::trash_service;
use myspace_lib::repositories::{devices, workspace_repository as repo};
use rusqlite::Connection;

fn root_board_id(conn: &Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
}

fn frame() -> Frame {
    Frame {
        x: 0.0,
        y: 0.0,
        width: 280.0,
        height: 180.0,
    }
}

fn alias(conn: &Connection, id: &str) -> FilesystemAliasDto {
    match repo::load_card(conn, id).unwrap() {
        CardDto::FilesystemAlias(alias) => alias,
        other => panic!("not an alias: {other:?}"),
    }
}

fn locator_rows(conn: &Connection, card_id: &str) -> Vec<(String, Vec<u8>)> {
    conn.prepare(
        "SELECT device_id, locator_blob FROM filesystem_alias_locators WHERE card_id = ?1 ORDER BY device_id",
    )
    .unwrap()
    .query_map([card_id], |r| Ok((r.get(0)?, r.get(1)?)))
    .unwrap()
    .map(Result::unwrap)
    .collect()
}

/// A workspace with one alias created on this device and one "foreign" alias
/// inserted the way a sync replay (or a moved database) would leave it: the
/// synced row only, origin = another device, no locator here.
fn workspace_with_local_and_foreign_alias() -> (Connection, String) {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    repo::create_filesystem_alias(
        &mut conn,
        &CreateFilesystemAliasInput {
            id: "local".into(),
            board_id: home.clone(),
            frame: frame(),
            z_index: 0,
            target_kind: "folder".into(),
            locator_blob: b"path:v1:/home/me/Local".to_vec(),
            path_hint: "/home/me/Local".into(),
            display_name: "Local".into(),
        },
    )
    .unwrap();
    conn.execute_batch(&format!(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at)
             VALUES ('foreign', '{home}', 'filesystem_alias', 0, 0, 280, 180, 1, 4, 0, 0);
         INSERT INTO filesystem_aliases (card_id, target_kind, path_hint, display_name, origin_device_id)
             VALUES ('foreign', 'folder', '/Users/me/Research', 'Research', 'other-device');
         INSERT INTO filesystem_alias_locators (card_id, device_id, locator_blob)
             VALUES ('foreign', 'other-device', X'626F6F6B');"
    ))
    .unwrap();
    (conn, home)
}

#[test]
fn migration_0024_attributes_legacy_aliases_and_keeps_triggers_working() {
    assert!(migrations::MIGRATIONS
        .iter()
        .any(|m| m.version == 24 && m.name == "device_scoped_locators" && m.after.is_some()));

    // A database at schema 0023 with one legacy alias (locator in the row).
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);",
    )
    .unwrap();
    for migration in migrations::MIGRATIONS.iter().filter(|m| m.version < 24) {
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
             VALUES ('fa1', 'home', 'filesystem_alias', 0, 0, 280, 180, 0, 0);
         INSERT INTO filesystem_aliases (card_id, target_kind, locator_blob, path_hint, display_name)
             VALUES ('fa1', 'folder', X'626F6F6B6D6163', '/Users/me/Footage', 'Footage');",
    )
    .unwrap();

    migrations::run_migrations(&mut conn).unwrap();

    let me = devices::load_device_identity(&conn).unwrap();
    let migrated = alias(&conn, "fa1");
    assert_eq!(migrated.origin_device_id, me.device_id);
    assert_eq!(
        migrated.origin_device_name.as_deref(),
        Some(me.device_name.as_str())
    );
    assert!(migrated.local, "the migrating device keeps its shortcut");
    assert_eq!(migrated.path_hint, "/Users/me/Footage");
    assert_eq!(
        locator_rows(&conn, "fa1"),
        vec![(me.device_id.clone(), b"bookmac".to_vec())],
        "the Mac bookmark bytes move verbatim"
    );
    assert_eq!(
        repo::load_filesystem_alias_locator(&conn, "fa1").unwrap().0,
        Some(b"bookmac".to_vec())
    );
    let has_legacy_column: bool = conn
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM pragma_table_info('filesystem_aliases') WHERE name = 'locator_blob')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!has_legacy_column);

    // The 0022/0023 triggers on filesystem_aliases survived the column drop.
    let seq_before: i64 = conn
        .query_row("SELECT change_seq FROM boards WHERE id = 'home'", [], |r| {
            r.get(0)
        })
        .unwrap();
    conn.execute(
        "UPDATE filesystem_aliases SET display_name = 'Galaxy' WHERE card_id = 'fa1'",
        [],
    )
    .unwrap();
    let seq_after: i64 = conn
        .query_row("SELECT change_seq FROM boards WHERE id = 'home'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(seq_after > seq_before);
    let hits = repo::search_workspace(&conn, "Galaxy").unwrap();
    assert_eq!(hits.len(), 1);

    // Idempotent: running the migrations again is a no-op.
    migrations::run_migrations(&mut conn).unwrap();
    assert_eq!(devices::load_device_identity(&conn).unwrap(), me);
}

#[test]
fn a_fresh_database_has_a_device_identity() {
    let conn = open_in_memory().unwrap();
    let me = devices::load_device_identity(&conn).unwrap();
    assert_eq!(
        uuid::Uuid::parse_str(&me.device_id)
            .unwrap()
            .get_version_num(),
        7
    );
    assert!(!me.device_name.is_empty());
}

#[test]
fn a_foreign_alias_is_not_local_and_names_its_origin_when_known() {
    let (conn, home) = workspace_with_local_and_foreign_alias();
    let me = devices::load_device_identity(&conn).unwrap();

    let local = alias(&conn, "local");
    assert!(local.local);
    assert_eq!(local.origin_device_id, me.device_id);
    assert_eq!(local.origin_device_name, Some(me.device_name.clone()));

    let foreign = alias(&conn, "foreign");
    assert!(!foreign.local);
    assert_eq!(foreign.origin_device_id, "other-device");
    assert_eq!(foreign.origin_device_name, None, "unknown device");
    assert_eq!(
        repo::load_filesystem_alias_locator(&conn, "foreign")
            .unwrap()
            .0,
        None,
        "another device's locator is never used here"
    );

    conn.execute(
        "INSERT INTO known_devices (device_id, name, last_seen_at) VALUES ('other-device', 'Studio Mac', 0)",
        [],
    )
    .unwrap();
    assert_eq!(
        alias(&conn, "foreign").origin_device_name.as_deref(),
        Some("Studio Mac")
    );

    // The board snapshot carries the same projection.
    let snapshot = repo::load_board_snapshot(&conn, &home).unwrap();
    let locals: Vec<(String, bool)> = snapshot
        .cards
        .iter()
        .filter_map(|c| match c {
            CardDto::FilesystemAlias(a) => Some((a.id.clone(), a.local)),
            _ => None,
        })
        .collect();
    assert_eq!(
        locals,
        vec![("local".into(), true), ("foreign".into(), false)]
    );
}

#[test]
fn pointing_a_foreign_alias_here_adds_only_this_devices_locator() {
    let (mut conn, _) = workspace_with_local_and_foreign_alias();
    let me = devices::load_device_identity(&conn).unwrap();
    let before = alias(&conn, "foreign");

    repo::set_filesystem_alias_local_target(&mut conn, "foreign", b"path:v1:C:\\Research").unwrap();

    let after = alias(&conn, "foreign");
    assert!(after.local);
    assert_eq!(
        after.revision, before.revision,
        "device-local: no revision bump"
    );
    assert_eq!(
        after.path_hint, "/Users/me/Research",
        "origin's hint is kept"
    );
    assert_eq!(after.origin_device_id, "other-device");
    let mut expected = vec![
        (me.device_id.clone(), b"path:v1:C:\\Research".to_vec()),
        ("other-device".to_string(), b"book".to_vec()),
    ];
    expected.sort();
    assert_eq!(locator_rows(&conn, "foreign"), expected);

    // Re-pointing replaces this device's locator, never the origin's.
    repo::set_filesystem_alias_local_target(&mut conn, "foreign", b"path:v1:D:\\Research").unwrap();
    assert_eq!(locator_rows(&conn, "foreign").len(), 2);

    assert!(matches!(
        repo::set_filesystem_alias_local_target(&mut conn, "missing", b"x"),
        Err(myspace_lib::domain::errors::WorkspaceError::NotFound(_))
    ));
}

#[test]
fn refresh_on_a_non_origin_device_keeps_the_synced_display_metadata() {
    let (mut conn, _) = workspace_with_local_and_foreign_alias();
    repo::set_filesystem_alias_local_target(&mut conn, "foreign", b"old").unwrap();
    repo::refresh_filesystem_alias_locator(&mut conn, "foreign", b"new", "/Local/R", "R").unwrap();
    let after = alias(&conn, "foreign");
    assert_eq!(after.path_hint, "/Users/me/Research");
    assert_eq!(after.display_name, "Research");
    assert_eq!(
        repo::load_filesystem_alias_locator(&conn, "foreign")
            .unwrap()
            .0,
        Some(b"new".to_vec())
    );

    // On the origin device the display metadata follows the renewal.
    repo::refresh_filesystem_alias_locator(&mut conn, "local", b"new", "/home/me/Moved", "Moved")
        .unwrap();
    assert_eq!(alias(&conn, "local").path_hint, "/home/me/Moved");
}

#[test]
fn locators_follow_duplicates_and_leave_with_the_card() {
    let (mut conn, home) = workspace_with_local_and_foreign_alias();

    // Duplicating (the kind's copy_detail after the new cards row exists)
    // copies the locators this database holds.
    {
        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT INTO cards (id, board_id, kind, x, y, width, height, created_at, updated_at)
             VALUES ('local-copy', ?1, 'filesystem_alias', 0, 0, 280, 180, 0, 0)",
            [&home],
        )
        .unwrap();
        handler(CardKind::FilesystemAlias)
            .copy_detail(
                &tx,
                "local",
                "local-copy",
                &CopyContext {
                    workspace_id: "ws",
                    new_board_id: &home,
                    now: 0,
                    depth: 1,
                },
            )
            .unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(
        locator_rows(&conn, "local-copy"),
        locator_rows(&conn, "local")
    );
    assert!(alias(&conn, "local-copy").local);

    trash_service::trash_selection(
        &mut conn,
        &TrashSelectionInput {
            items: vec![TrashItem {
                id: "foreign".into(),
                kind: "filesystem_alias".into(),
            }],
        },
    )
    .unwrap();
    trash_service::empty_trash(&mut conn, "EMPTY").unwrap();
    assert!(locator_rows(&conn, "foreign").is_empty());
    assert_eq!(locator_rows(&conn, "local").len(), 1);
    let violations = conn
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .query_map([], |_| Ok(()))
        .unwrap()
        .count();
    assert_eq!(violations, 0);
}

/// Every table's rows, as text, except the local-only tables and the
/// derived FTS tables.
fn shared_state(conn: &Connection) -> Vec<(String, Vec<String>)> {
    let tables: Vec<String> = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'
             AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_index%'
             ORDER BY name",
        )
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    tables
        .into_iter()
        .filter(|t| !LOCAL_ONLY_TABLES.contains(&t.as_str()))
        .map(|table| {
            let mut stmt = conn
                .prepare(&format!("SELECT * FROM {table} ORDER BY 1"))
                .unwrap();
            let width = stmt.column_count();
            let rows = stmt
                .query_map([], |row| {
                    let mut cells = Vec::with_capacity(width);
                    for i in 0..width {
                        let value: rusqlite::types::Value = row.get(i)?;
                        cells.push(format!("{value:?}"));
                    }
                    Ok(cells.join("|"))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect();
            (table, rows)
        })
        .collect()
}

#[test]
fn local_only_mutations_write_only_local_only_tables() {
    let (mut conn, home) = workspace_with_local_and_foreign_alias();
    let dir = std::env::temp_dir().join(format!("myspace-local-only-{}", uuid::Uuid::now_v7()));
    let paths = WorkspacePaths::new(&dir);
    let viewport_revision: i64 = conn
        .query_row(
            "SELECT revision FROM board_view_states WHERE board_id = ?1",
            [&home],
            |r| r.get(0),
        )
        .unwrap();

    let mutations = vec![
        Mutation::SetFilesystemAliasLocalTarget {
            card_id: "foreign".into(),
            locator_blob: b"path:v1:/x".to_vec(),
        },
        Mutation::RenameDevice {
            name: "Renamed".into(),
        },
        Mutation::SaveViewport(UpdateViewportInput {
            board_id: home.clone(),
            expected_revision: viewport_revision,
            x: 10.0,
            y: 20.0,
            zoom: 1.5,
        }),
    ];
    for mutation in mutations {
        assert!(mutation.is_local_only(), "{}", mutation.name());
        let before = shared_state(&conn);
        mutation.execute(&mut conn, &paths).unwrap();
        assert_eq!(
            shared_state(&conn),
            before,
            "{} changed a synced table",
            mutation.name()
        );
    }
    assert_eq!(
        devices::load_device_identity(&conn).unwrap().device_name,
        "Renamed"
    );
    assert!(
        !Mutation::CreateFilesystemAlias(CreateFilesystemAliasInput {
            id: "x".into(),
            board_id: home,
            frame: frame(),
            z_index: 0,
            target_kind: "folder".into(),
            locator_blob: vec![],
            path_hint: String::new(),
            display_name: String::new(),
        })
        .is_local_only()
    );
}

#[test]
fn a_database_copied_to_another_data_dir_gets_a_new_identity_and_foreign_shortcuts() {
    let root = std::env::temp_dir().join(format!("myspace-copy-{}", uuid::Uuid::now_v7()));
    let (source, copy) = (root.join("mac"), root.join("pc"));
    std::fs::create_dir_all(&source).unwrap();
    std::fs::create_dir_all(&copy).unwrap();

    let origin = {
        let mut conn =
            myspace_lib::db::open_and_bootstrap(&source.join("workspace.sqlite3")).unwrap();
        let home = root_board_id(&conn);
        repo::create_filesystem_alias(
            &mut conn,
            &CreateFilesystemAliasInput {
                id: "fa".into(),
                board_id: home,
                frame: frame(),
                z_index: 0,
                target_kind: "folder".into(),
                locator_blob: b"book".to_vec(),
                path_hint: "/Users/me/A".into(),
                display_name: "A".into(),
            },
        )
        .unwrap();
        assert!(alias(&conn, "fa").local);
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
        devices::load_device_identity(&conn).unwrap()
    };

    // Reopening in place keeps the identity.
    let again = myspace_lib::db::open_and_bootstrap(&source.join("workspace.sqlite3")).unwrap();
    assert_eq!(devices::load_device_identity(&again).unwrap(), origin);
    again
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    drop(again);

    std::fs::copy(
        source.join("workspace.sqlite3"),
        copy.join("workspace.sqlite3"),
    )
    .unwrap();
    let conn = myspace_lib::db::open_and_bootstrap(&copy.join("workspace.sqlite3")).unwrap();
    let here = devices::load_device_identity(&conn).unwrap();
    assert_ne!(here.device_id, origin.device_id);
    let copied = alias(&conn, "fa");
    assert!(!copied.local);
    assert_eq!(copied.origin_device_id, origin.device_id);
    assert_eq!(copied.origin_device_name, Some(origin.device_name));
    drop(conn);
    let _ = std::fs::remove_dir_all(root);
}
