//! Asset mark-and-sweep: only unreferenced asset files + rows are deleted, and
//! a missing orphan file still removes its metadata row so the sweep converges.

use std::fs;

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::asset_service;

fn temp_asset_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("myspace-gc-{}", uuid::Uuid::now_v7()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn insert_asset(conn: &rusqlite::Connection, id: &str, file_path: &str) {
    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at)
         VALUES (?1, ?2, 'image/png', ?2, NULL, NULL, 0, 0)",
        rusqlite::params![id, file_path],
    )
    .unwrap();
}

fn home_board_id(conn: &rusqlite::Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
}

fn insert_card(conn: &rusqlite::Connection, id: &str, board_id: &str, kind: &str) {
    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, 0, 320, 240, 0, 1, 0, 0)",
        rusqlite::params![id, board_id, kind],
    )
    .unwrap();
}

fn asset_row_count(conn: &rusqlite::Connection, id: &str) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM assets WHERE id = ?1", [id], |r| {
        r.get(0)
    })
    .unwrap()
}

#[test]
fn referenced_asset_survives() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let asset_dir = temp_asset_dir();

    insert_asset(&conn, "a1", "a1.png");
    fs::write(asset_dir.join("a1.png"), b"x").unwrap();
    // Reference it as a board cover so it is marked.
    conn.execute("UPDATE boards SET cover_asset_id = 'a1'", [])
        .unwrap();

    let collected = asset_service::collect_orphaned_assets(&mut conn, &asset_dir).unwrap();
    assert_eq!(collected, 0);
    assert!(asset_dir.join("a1.png").exists());
}

#[test]
fn unreferenced_asset_is_collected() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let asset_dir = temp_asset_dir();

    insert_asset(&conn, "a2", "a2.png");
    fs::write(asset_dir.join("a2.png"), b"y").unwrap();

    let collected = asset_service::collect_orphaned_assets(&mut conn, &asset_dir).unwrap();
    assert_eq!(collected, 1);
    assert!(!asset_dir.join("a2.png").exists());
    let remaining: i64 = conn
        .query_row("SELECT COUNT(*) FROM assets WHERE id = 'a2'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(remaining, 0);
}

#[test]
fn missing_orphan_file_still_removes_metadata() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let asset_dir = temp_asset_dir();

    // a3 has a metadata row but no file (mimics an interrupted sweep).
    insert_asset(&conn, "a3", "a3.png");

    let collected = asset_service::collect_orphaned_assets(&mut conn, &asset_dir).unwrap();
    assert_eq!(collected, 1);
    let remaining: i64 = conn
        .query_row("SELECT COUNT(*) FROM assets WHERE id = 'a3'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(remaining, 0);
}

#[test]
fn file_card_primary_asset_survives_gc() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let asset_dir = temp_asset_dir();
    let home = home_board_id(&conn);

    insert_asset(&conn, "fc-primary", "fc-primary.txt");
    fs::write(asset_dir.join("fc-primary.txt"), b"x").unwrap();
    insert_card(&conn, "fc-card", &home, "file");
    conn.execute(
        "INSERT INTO file_cards (card_id, asset_id, mime_type, preview_text) VALUES ('fc-card', 'fc-primary', 'text/plain', 'hi')",
        [],
    )
    .unwrap();

    let collected = asset_service::collect_orphaned_assets(&mut conn, &asset_dir).unwrap();
    assert_eq!(collected, 0, "primary file-card asset must not be orphaned");
    assert!(asset_dir.join("fc-primary.txt").exists());
    assert_eq!(asset_row_count(&conn, "fc-primary"), 1);
}

#[test]
fn file_card_preview_asset_survives_gc() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let asset_dir = temp_asset_dir();
    let home = home_board_id(&conn);

    insert_asset(&conn, "fc-primary", "fc-primary.txt");
    insert_asset(&conn, "fc-preview", "fc-preview.png");
    fs::write(asset_dir.join("fc-primary.txt"), b"x").unwrap();
    fs::write(asset_dir.join("fc-preview.png"), b"y").unwrap();
    insert_card(&conn, "fc-card", &home, "file");
    conn.execute(
        "INSERT INTO file_cards (card_id, asset_id, mime_type, preview_text, preview_asset_id) VALUES ('fc-card', 'fc-primary', 'text/plain', 'hi', 'fc-preview')",
        [],
    )
    .unwrap();

    let collected = asset_service::collect_orphaned_assets(&mut conn, &asset_dir).unwrap();
    assert_eq!(collected, 0, "preview file-card asset must not be orphaned");
    assert!(asset_dir.join("fc-primary.txt").exists());
    assert!(asset_dir.join("fc-preview.png").exists());
    assert_eq!(asset_row_count(&conn, "fc-primary"), 1);
    assert_eq!(asset_row_count(&conn, "fc-preview"), 1);
}

#[test]
fn cache_only_favicon_is_collected_without_fk_failure() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let asset_dir = temp_asset_dir();

    insert_asset(&conn, "fav-cache", "fav-cache.ico");
    fs::write(asset_dir.join("fav-cache.ico"), b"f").unwrap();
    // favicon_cache is an acceleration index, not an owner.
    conn.execute(
        "INSERT INTO favicon_cache (source_url, asset_id) VALUES ('https://example.com/favicon.ico', 'fav-cache')",
        [],
    )
    .unwrap();

    let collected = asset_service::collect_orphaned_assets(&mut conn, &asset_dir).unwrap();
    assert_eq!(collected, 1);
    assert!(!asset_dir.join("fav-cache.ico").exists());
    assert_eq!(asset_row_count(&conn, "fav-cache"), 0);
    let cache_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM favicon_cache WHERE asset_id = 'fav-cache'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(cache_rows, 0, "cache row must be removed transactionally");
}

#[test]
fn live_favicon_reference_survives_gc() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let asset_dir = temp_asset_dir();
    let home = home_board_id(&conn);

    insert_asset(&conn, "fav-live", "fav-live.ico");
    fs::write(asset_dir.join("fav-live.ico"), b"f").unwrap();
    insert_card(&conn, "embed-card", &home, "embed");
    conn.execute(
        "INSERT INTO embed_cards (card_id, source_url, display_url, title, description_json, description_plain_text, metadata_status) VALUES ('embed-card', 'https://example.com', 'example.com', 't', '{}', '', 'ready')",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE embed_cards SET favicon_asset_id = 'fav-live' WHERE card_id = 'embed-card'",
        [],
    )
    .unwrap();
    // Cache also references the same favicon; the durable owner still wins.
    conn.execute(
        "INSERT INTO favicon_cache (source_url, asset_id) VALUES ('https://example.com', 'fav-live')",
        [],
    )
    .unwrap();

    let collected = asset_service::collect_orphaned_assets(&mut conn, &asset_dir).unwrap();
    assert_eq!(collected, 0, "live favicon reference must survive");
    assert!(asset_dir.join("fav-live.ico").exists());
    assert_eq!(asset_row_count(&conn, "fav-live"), 1);
}

#[test]
fn repeated_cleanup_converges_after_cache_only_orphan() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let asset_dir = temp_asset_dir();

    insert_asset(&conn, "fav-repeat", "fav-repeat.ico");
    fs::write(asset_dir.join("fav-repeat.ico"), b"f").unwrap();
    conn.execute(
        "INSERT INTO favicon_cache (source_url, asset_id) VALUES ('https://example.com/r.ico', 'fav-repeat')",
        [],
    )
    .unwrap();

    let first = asset_service::collect_orphaned_assets(&mut conn, &asset_dir).unwrap();
    assert_eq!(first, 1, "first sweep collects the cache-only orphan");
    let second = asset_service::collect_orphaned_assets(&mut conn, &asset_dir).unwrap();
    assert_eq!(second, 0, "second sweep finds nothing left to collect");
    assert_eq!(asset_row_count(&conn, "fav-repeat"), 0);
}
