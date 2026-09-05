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

    // Exactly one snapshot dir exists (staging is consumed on publish).
    let entries: Vec<_> = std::fs::read_dir(&backup_root)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();
    assert_eq!(entries.len(), 1);

    let snapshot_dir = backup_root.join(entries[0].file_name());
    let snapshot_db = snapshot_dir.join("workspace.sqlite3");
    let manifest = snapshot_dir.join("manifest.json");
    assert!(
        manifest.exists(),
        "manifest.json must be published with the snapshot"
    );

    let manifest_json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    assert_eq!(manifest_json["validation"], "ok");

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

/// Seeds a validated snapshot directory (with a success manifest).
fn seed_validated_backup(backup_root: &Path, name: &str) {
    let dir = backup_root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("workspace.sqlite3"), b"").unwrap();
    let manifest = serde_json::json!({ "validation": "ok", "asset_count": 0, "schema_version": 1 });
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
}

#[test]
fn retention_prunes_only_validated_snapshots() {
    let root = temp_dir("retention");
    let backup_root = root.join("backups");
    std::fs::create_dir_all(&backup_root).unwrap();

    // Seed 15 validated snapshots with old, lexicographically-sorted names.
    for i in 0..15u32 {
        seed_validated_backup(&backup_root, &format!("{i:020}"));
    }
    // A stray unvalidated dir must NOT be pruned (no manifest).
    std::fs::create_dir_all(backup_root.join("9000-stray")).unwrap();

    backup::prune_old_backups(&backup_root);

    // 10 validated remain (oldest 5 removed); the stray is untouched.
    let validated_count = std::fs::read_dir(&backup_root)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir() && e.path().join("manifest.json").exists())
        .count();
    assert_eq!(validated_count, 10);
    assert!(backup_root.join("9000-stray").exists());

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

#[test]
fn restore_preserves_damaged_live_db_before_replacement() {
    let root = temp_dir("restore");
    let db_path = root.join("workspace.sqlite3");
    let assets = root.join("assets");
    let backup_root = root.join("backups");

    // Build a valid snapshot containing a known row.
    {
        let mut conn = open_in_memory().unwrap();
        migrations::run_migrations(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, title, root_board_id, created_at, updated_at)
             VALUES ('good', 'Restored', 'b', 0, 0)",
            [],
        )
        .unwrap();
        let snapshot_dir = root.join("snap");
        std::fs::create_dir_all(&snapshot_dir).unwrap();
        let mut file_conn =
            rusqlite::Connection::open(snapshot_dir.join("workspace.sqlite3")).unwrap();
        {
            let bk = rusqlite::backup::Backup::new(&conn, &mut file_conn).unwrap();
            bk.run_to_completion(100, std::time::Duration::from_millis(10), None)
                .unwrap();
        }
        std::fs::create_dir_all(&backup_root).unwrap();

        // A damaged live DB at the target path.
        std::fs::write(&db_path, b"garbage-not-a-db").unwrap();

        let preserve =
            backup::restore_from_backup(&snapshot_dir, &db_path, &assets, &backup_root).unwrap();

        // The preserved dir must contain the damaged DB.
        assert!(preserve.join("workspace.sqlite3").exists());
        // The live path now holds the good row.
        let live = rusqlite::Connection::open(&db_path).unwrap();
        let title: String = live
            .query_row("SELECT title FROM workspaces WHERE id = 'good'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(title, "Restored");
    }

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn snapshot_is_rate_limited_on_rapid_restarts() {
    let root = temp_dir("ratelimit");
    let db_path = root.join("workspace.sqlite3");
    let assets = root.join("assets");
    let backup_root = root.join("backups");

    // Create a real migrated DB at the path so asset enumeration succeeds.
    {
        let mut conn = open_in_memory().unwrap();
        migrations::run_migrations(&mut conn).unwrap();
        let mut file_conn = rusqlite::Connection::open(&db_path).unwrap();
        {
            let bk = rusqlite::backup::Backup::new(&conn, &mut file_conn).unwrap();
            bk.run_to_completion(100, std::time::Duration::from_millis(10), None)
                .unwrap();
        }
    }

    // First snapshot succeeds (no prior backup -> not rate-limited).
    backup::snapshot_on_startup(&db_path, &assets, &backup_root);
    let count_after_first = std::fs::read_dir(&backup_root)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .count();
    assert_eq!(count_after_first, 1);

    // A second immediate snapshot must be skipped by the rate limiter.
    backup::snapshot_on_startup(&db_path, &assets, &backup_root);
    let count_after_second = std::fs::read_dir(&backup_root)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .count();
    assert_eq!(count_after_second, 1);

    std::fs::remove_dir_all(&root).ok();
}
