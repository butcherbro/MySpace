//! Backup tests: a startup snapshot must be a consistent, standalone copy of the
//! live database, and retention must drop the oldest snapshots.

use myspace_lib::db::{backup, migrations, open_in_memory};
use std::path::Path;

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("myspace-backup-{}-{}", tag, uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn snapshot_is_a_consistent_standalone_database() {
    // Build a live DB with a known row inside a temp dir.
    let root = temp_dir("live");
    let db_path = root.join("workspace.sqlite3");
    let assets = root.join("assets");

    {
        let mut conn = open_in_memory().unwrap();
        migrations::run_migrations(&mut conn).unwrap();
        // Persist a recognizable row.
        conn.execute(
            "INSERT INTO workspaces (id, title, root_board_id, created_at, updated_at)
             VALUES ('ws-1', 'Home', 'board-1', 0, 0)",
            [],
        )
        .unwrap();

        // Write the in-memory DB to the live path.
        let mut file_conn = rusqlite::Connection::open(&db_path).unwrap();
        {
            let bk = rusqlite::backup::Backup::new(&conn, &mut file_conn).unwrap();
            bk.run_to_completion(100, std::time::Duration::from_millis(10), None)
                .unwrap();
        }
    }

    let backup_root = root.join("backups");
    backup::snapshot_on_startup(&db_path, &assets, &backup_root);

    // Exactly one snapshot dir exists.
    let entries: Vec<_> = std::fs::read_dir(&backup_root)
        .unwrap()
        .filter_map(|e| e.ok())
        .collect();
    assert_eq!(entries.len(), 1);

    let snapshot_db = backup_root
        .join(entries[0].file_name())
        .join("workspace.sqlite3");

    // Open the snapshot and verify it is valid and contains the row.
    let snap = rusqlite::Connection::open(&snapshot_db).unwrap();
    let integrity: String = snap
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");

    let title: String = snap
        .query_row("SELECT title FROM workspaces WHERE id = 'ws-1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(title, "Home");

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn retention_keeps_only_the_most_recent_snapshots() {
    let root = temp_dir("retention");
    let db_path = root.join("workspace.sqlite3");
    let assets = root.join("assets");

    // Create a valid live DB at the path (snapshot_on_startup requires an
    // openable path; an empty file is also fine since backup only reads it).
    std::fs::write(&db_path, b"").unwrap();

    let backup_root = root.join("backups");
    // Simulate many snapshots by calling startup snapshot repeatedly with a
    // manipulated clock is not possible here, so instead seed fake older dirs and
    // then run once to trigger prune.
    std::fs::create_dir_all(&backup_root).unwrap();
    for i in 0..15u32 {
        std::fs::create_dir_all(backup_root.join(format!("{i:020}"))).unwrap();
    }

    // Run once: it adds a 16th snapshot, then prunes down to retention (10).
    backup::snapshot_on_startup(&db_path, &assets, &backup_root);

    let dirs: Vec<String> = std::fs::read_dir(&backup_root)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();

    assert!(
        dirs.len() <= 10,
        "expected <= 10 snapshots, got {}",
        dirs.len()
    );

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn snapshot_is_best_effort_when_db_is_missing() {
    let root = temp_dir("missing");
    let backup_root = root.join("backups");
    // Point at a nonexistent db: must not panic, and must not create a snapshot.
    backup::snapshot_on_startup(
        &root.join("does-not-exist.sqlite3"),
        &root.join("assets"),
        &backup_root,
    );
    // No snapshot dir should be left behind.
    let has_snapshot = Path::new(&backup_root)
        .read_dir()
        .map(|mut d| d.any(|e| e.is_ok()))
        .unwrap_or(false);
    assert!(!has_snapshot);

    std::fs::remove_dir_all(&root).ok();
}
