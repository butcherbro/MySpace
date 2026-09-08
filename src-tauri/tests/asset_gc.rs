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
