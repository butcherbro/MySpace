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
    assert_eq!(manifest_json["missing_asset_count"], 0);
    assert_eq!(manifest_json["missing_assets"], serde_json::json!([]));

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
fn snapshot_still_publishes_when_one_asset_file_is_missing() {
    // A missing referenced asset file must not block the whole snapshot (the
    // DB is still consistent and is what matters most for recovery); it is
    // recorded as a warning in the manifest instead.
    let root = temp_dir("missing-asset");
    let db_path = root.join("workspace.sqlite3");
    let assets = root.join("assets");
    std::fs::create_dir_all(&assets).unwrap();

    {
        let mut conn = open_in_memory().unwrap();
        migrations::run_migrations(&mut conn).unwrap();

        // Two referenced assets: one present on disk, one missing.
        conn.execute(
            "INSERT INTO assets (id, file_path, mime_type, file_name, size_bytes, created_at)
             VALUES ('a-present', 'present.png', 'image/png', 'present.png', 3, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO assets (id, file_path, mime_type, file_name, size_bytes, created_at)
             VALUES ('a-missing', 'missing.png', 'image/png', 'missing.png', 3, 0)",
            [],
        )
        .unwrap();

        let mut file_conn = rusqlite::Connection::open(&db_path).unwrap();
        {
            let bk = rusqlite::backup::Backup::new(&conn, &mut file_conn).unwrap();
            bk.run_to_completion(100, std::time::Duration::from_millis(10), None)
                .unwrap();
        }
    }

    // Only the present asset actually exists on disk.
    std::fs::write(assets.join("present.png"), b"abc").unwrap();

    let backup_root = root.join("backups");
    backup::snapshot_on_startup(&db_path, &assets, &backup_root);

    let entries: Vec<_> = std::fs::read_dir(&backup_root)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();
    assert_eq!(
        entries.len(),
        1,
        "a missing asset file must not block publishing the snapshot"
    );

    let snapshot_dir = backup_root.join(entries[0].file_name());
    let manifest_json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(snapshot_dir.join("manifest.json")).unwrap())
            .unwrap();
    assert_eq!(manifest_json["validation"], "ok");
    assert_eq!(manifest_json["missing_asset_count"], 1);
    assert_eq!(
        manifest_json["missing_assets"],
        serde_json::json!(["missing.png"])
    );

    // The present asset was still copied into the snapshot.
    assert!(snapshot_dir.join("assets").join("present.png").exists());
    assert!(!snapshot_dir.join("assets").join("missing.png").exists());

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

// ---- Backup 2.0 (P1.2): hard links, byte retention, restore contract --------

/// A live workspace under a temp dir: a migrated DB with `files` asset rows
/// (hashed) and their files on disk. Returns the data dir.
fn live_workspace_with_assets(tag: &str, files: &[(&str, &[u8])]) -> std::path::PathBuf {
    let root = temp_dir(tag);
    let assets = root.join("assets");
    std::fs::create_dir_all(&assets).unwrap();
    let mut conn = open_in_memory().unwrap();
    migrations::run_migrations(&mut conn).unwrap();
    conn.execute(
        "INSERT INTO workspaces (id, title, root_board_id, created_at, updated_at)
         VALUES ('ws-1', 'Home', 'board-1', 0, 0)",
        [],
    )
    .unwrap();
    for (i, (name, bytes)) in files.iter().enumerate() {
        std::fs::write(assets.join(name), bytes).unwrap();
        conn.execute(
            "INSERT INTO assets (id, file_path, mime_type, file_name, size_bytes, created_at, sha256)
             VALUES (?1, ?2, 'image/png', ?2, ?3, 0, ?4)",
            rusqlite::params![
                format!("a-{i}"),
                name,
                bytes.len() as i64,
                myspace_lib::domain::asset_service::sha256_hex(bytes)
            ],
        )
        .unwrap();
    }
    let mut file_conn = rusqlite::Connection::open(root.join("workspace.sqlite3")).unwrap();
    {
        let bk = rusqlite::backup::Backup::new(&conn, &mut file_conn).unwrap();
        bk.run_to_completion(100, std::time::Duration::from_millis(10), None)
            .unwrap();
    }
    root
}

fn snapshot(root: &Path) -> backup::SnapshotReport {
    backup::snapshot_before_destructive_operation(
        &root.join("workspace.sqlite3"),
        &root.join("assets"),
        &root.join("backups"),
    )
    .unwrap()
}

/// Bytes of distinct inodes under `dir` (every file counted once however many
/// hard links point at it).
#[cfg(unix)]
fn unique_inode_bytes(dirs: &[&Path]) -> u64 {
    use std::os::unix::fs::MetadataExt;
    fn walk(dir: &Path, seen: &mut std::collections::HashSet<(u64, u64)>, total: &mut u64) {
        for entry in std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()) {
            let meta = std::fs::symlink_metadata(entry.path()).unwrap();
            if meta.is_dir() {
                walk(&entry.path(), seen, total);
            } else if seen.insert((meta.dev(), meta.ino())) {
                *total += meta.len();
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    let mut total = 0;
    for dir in dirs {
        walk(dir, &mut seen, &mut total);
    }
    total
}

#[cfg(unix)]
#[test]
fn snapshot_hard_links_assets_on_the_same_volume() {
    use std::os::unix::fs::MetadataExt;
    let root = live_workspace_with_assets("hardlink", &[("a.png", b"alpha"), ("b.png", b"beta")]);
    let report = snapshot(&root);
    assert_eq!(report.asset_count, 2);
    assert_eq!(report.linked_asset_count, 2);

    for name in ["a.png", "b.png"] {
        let live = std::fs::metadata(root.join("assets").join(name)).unwrap();
        let snap = std::fs::metadata(report.dir.join("assets").join(name)).unwrap();
        assert!(snap.nlink() >= 2, "{name} must be hard-linked");
        assert_eq!(live.ino(), snap.ino());
    }

    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(report.dir.join("manifest.json")).unwrap()).unwrap();
    let assets = manifest["assets"].as_array().unwrap();
    assert_eq!(assets.len(), 2);
    let a = assets.iter().find(|a| a["file_path"] == "a.png").unwrap();
    assert_eq!(a["linked"], true);
    assert_eq!(
        a["sha256"],
        myspace_lib::domain::asset_service::sha256_hex(b"alpha")
    );
    assert_eq!(manifest["missing_asset_count"], 0);

    std::fs::remove_dir_all(&root).ok();
}

#[cfg(unix)]
#[test]
fn ten_snapshots_cost_about_one_copy_of_the_assets() {
    let payload = vec![7u8; 64 * 1024];
    let files: Vec<(String, Vec<u8>)> = (0..5)
        .map(|i| {
            let mut bytes = payload.clone();
            bytes[0] = i as u8;
            (format!("f{i}.bin"), bytes)
        })
        .collect();
    let refs: Vec<(&str, &[u8])> = files
        .iter()
        .map(|(n, b)| (n.as_str(), b.as_slice()))
        .collect();
    let root = live_workspace_with_assets("ten", &refs);
    let asset_bytes: u64 = files.iter().map(|(_, b)| b.len() as u64).sum();

    let mut dirs = Vec::new();
    for _ in 0..10 {
        dirs.push(snapshot(&root).dir);
    }
    assert_eq!(
        backup::list_backups(&root.join("backups")).len(),
        10,
        "ten distinct snapshot dirs even within one second"
    );

    // Distinct inodes across the live assets and all ten snapshots: one copy of
    // the assets plus ten small DB files and manifests.
    let assets_dir = root.join("assets");
    let backups_dir = root.join("backups");
    let unique = unique_inode_bytes(&[&assets_dir, &backups_dir]);
    let db_and_manifest_bytes: u64 = dirs
        .iter()
        .map(|d| {
            std::fs::metadata(d.join("workspace.sqlite3"))
                .unwrap()
                .len()
                + std::fs::metadata(d.join("manifest.json")).unwrap().len()
        })
        .sum();
    assert_eq!(unique, asset_bytes + db_and_manifest_bytes);

    // What the snapshots themselves cost (files also linked from the live
    // assets dir are free): only DBs and manifests.
    assert_eq!(backup::snapshots_disk_bytes(&dirs), db_and_manifest_bytes);

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn byte_retention_prunes_oldest_first_and_keeps_the_newest() {
    let root = temp_dir("byte-retention");
    let backup_root = root.join("backups");
    // Five validated snapshots of 1 000 bytes each (independent files).
    for i in 0..5u32 {
        let name = format!("{}", 1_000_000 + i);
        seed_validated_backup(&backup_root, &name);
        std::fs::write(backup_root.join(&name).join("blob.bin"), vec![0u8; 1000]).unwrap();
    }

    // Count limit is generous; the byte limit allows only two.
    backup::prune_backups_with_limits(&backup_root, 10, 2_500);
    let mut left: Vec<String> = std::fs::read_dir(&backup_root)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    assert_eq!(left, vec!["1000003".to_string(), "1000004".to_string()]);

    // A limit below the newest snapshot's own size still keeps the newest.
    backup::prune_backups_with_limits(&backup_root, 10, 10);
    let left: Vec<String> = std::fs::read_dir(&backup_root)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(left, vec!["1000004".to_string()]);

    std::fs::remove_dir_all(&root).ok();
}

#[cfg(unix)]
#[test]
fn byte_retention_counts_a_hard_linked_file_once() {
    // Two snapshots hard-linking the same 1 000-byte file (no live link):
    // together they cost 1 000 bytes, not 2 000.
    let root = temp_dir("byte-links");
    let backup_root = root.join("backups");
    seed_validated_backup(&backup_root, "1000000");
    seed_validated_backup(&backup_root, "1000001");
    let first = backup_root.join("1000000").join("blob.bin");
    std::fs::write(&first, vec![0u8; 1000]).unwrap();
    std::fs::hard_link(&first, backup_root.join("1000001").join("blob.bin")).unwrap();

    backup::prune_backups_with_limits(&backup_root, 10, 1_500);
    assert!(backup_root.join("1000000").exists());
    assert!(backup_root.join("1000001").exists());

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn restore_from_a_hard_linked_snapshot_round_trips_without_touching_it() {
    let root =
        live_workspace_with_assets("restore-links", &[("a.png", b"alpha"), ("b.png", b"beta")]);
    let report = snapshot(&root);
    let snap_asset = report.dir.join("assets").join("a.png");

    // Damage the live workspace: overwrite one asset in place, delete another.
    // (Writing in place through a hard link would also change the snapshot, so
    // replace the file first, which is what any real writer does.)
    std::fs::remove_file(root.join("assets").join("a.png")).unwrap();
    std::fs::write(root.join("assets").join("a.png"), b"CORRUPT").unwrap();
    std::fs::remove_file(root.join("assets").join("b.png")).unwrap();

    let preserved = backup::restore_from_backup(
        &report.dir,
        &root.join("workspace.sqlite3"),
        &root.join("assets"),
        &root.join("backups"),
    )
    .unwrap();
    assert!(preserved.join("assets").join("a.png").exists());

    assert_eq!(
        std::fs::read(root.join("assets").join("a.png")).unwrap(),
        b"alpha"
    );
    assert_eq!(
        std::fs::read(root.join("assets").join("b.png")).unwrap(),
        b"beta"
    );

    // Restored files are independent copies: writing to one must not reach the
    // snapshot.
    std::fs::write(root.join("assets").join("a.png"), b"edited-after-restore").unwrap();
    assert_eq!(std::fs::read(&snap_asset).unwrap(), b"alpha");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let restored = std::fs::metadata(root.join("assets").join("b.png")).unwrap();
        let snap = std::fs::metadata(report.dir.join("assets").join("b.png")).unwrap();
        assert_ne!(restored.ino(), snap.ino());
    }

    // The snapshot is still listed as valid.
    let listed = backup::list_backups(&root.join("backups"));
    assert!(listed
        .iter()
        .any(|b| report.dir.ends_with(&b.dir_name) && b.valid));

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn list_backups_reports_newest_first_and_flags_invalid_snapshots() {
    let root = live_workspace_with_assets("list", &[("a.png", b"alpha")]);
    let first = snapshot(&root);
    let second = snapshot(&root);
    // A dir with a manifest claiming "ok" but a garbage DB is listed invalid.
    let bogus = root.join("backups").join("1");
    std::fs::create_dir_all(&bogus).unwrap();
    std::fs::write(bogus.join("workspace.sqlite3"), b"garbage").unwrap();
    std::fs::write(bogus.join("manifest.json"), br#"{"validation":"ok"}"#).unwrap();
    // Hidden staging dirs are never listed.
    std::fs::create_dir_all(root.join("backups").join(".staging-x")).unwrap();

    let listed = backup::list_backups(&root.join("backups"));
    let names: Vec<&str> = listed.iter().map(|b| b.dir_name.as_str()).collect();
    let first_name = first.dir.file_name().unwrap().to_str().unwrap();
    let second_name = second.dir.file_name().unwrap().to_str().unwrap();
    assert_eq!(names, vec![second_name, first_name, "1"]);
    assert!(listed[0].valid && listed[1].valid);
    assert!(!listed[2].valid);
    assert_eq!(listed[0].asset_count, 1);
    assert!(listed[0].schema_version >= 20);
    assert!(listed[0].total_bytes > 0);
    assert!(listed[0].created_at_secs > 0);

    let json = serde_json::to_value(&listed[0]).unwrap();
    for key in [
        "dirName",
        "createdAtSecs",
        "schemaVersion",
        "assetCount",
        "totalBytes",
        "valid",
    ] {
        assert!(json.get(key).is_some(), "BackupSummary JSON lacks {key}");
    }

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn request_restore_then_apply_pending_restore_round_trips() {
    let root = live_workspace_with_assets("pending", &[("a.png", b"alpha")]);
    let report = snapshot(&root);
    let name = report
        .dir
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();

    // Change the live state after the snapshot.
    {
        let live = rusqlite::Connection::open(root.join("workspace.sqlite3")).unwrap();
        live.execute("UPDATE workspaces SET title = 'Changed'", [])
            .unwrap();
    }
    std::fs::remove_file(root.join("assets").join("a.png")).unwrap();

    // Nothing pending yet.
    assert_eq!(backup::apply_pending_restore(&root).unwrap(), None);

    // Bad names are refused and leave no marker.
    for bad in ["", "..", "../x", "a/b", ".staging-x", "does-not-exist"] {
        assert!(backup::request_restore(&root, bad).is_err(), "{bad:?}");
    }
    assert!(!root.join(backup::RESTORE_MARKER).exists());

    backup::request_restore(&root, &name).unwrap();
    let marker: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join(backup::RESTORE_MARKER)).unwrap()).unwrap();
    assert_eq!(marker, serde_json::json!({ "snapshot": name }));

    let preserved = backup::apply_pending_restore(&root)
        .unwrap()
        .expect("a restore was pending");
    assert!(preserved.join("workspace.sqlite3").exists());
    assert!(
        !root.join(backup::RESTORE_MARKER).exists(),
        "marker consumed"
    );

    let live = rusqlite::Connection::open(root.join("workspace.sqlite3")).unwrap();
    let title: String = live
        .query_row("SELECT title FROM workspaces WHERE id = 'ws-1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(title, "Home");
    assert_eq!(
        std::fs::read(root.join("assets").join("a.png")).unwrap(),
        b"alpha"
    );
    assert_eq!(
        std::fs::read(report.dir.join("assets").join("a.png")).unwrap(),
        b"alpha"
    );

    // Consumed: a second startup does nothing.
    assert_eq!(backup::apply_pending_restore(&root).unwrap(), None);

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn a_failed_pending_restore_is_not_retried() {
    let root = temp_dir("pending-bad");
    std::fs::write(
        root.join(backup::RESTORE_MARKER),
        br#"{"snapshot":"missing"}"#,
    )
    .unwrap();
    assert!(backup::apply_pending_restore(&root).is_err());
    assert!(!root.join(backup::RESTORE_MARKER).exists());
    assert_eq!(backup::apply_pending_restore(&root).unwrap(), None);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn snapshot_of_a_pre_0020_database_still_lists_assets() {
    // The pre-upgrade snapshot runs before migrations, so the DB has no
    // `assets.sha256` column yet; the manifest records sha256 as null.
    let root = temp_dir("pre-0020");
    let assets = root.join("assets");
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::write(assets.join("old.png"), b"old").unwrap();
    {
        let conn = rusqlite::Connection::open(root.join("workspace.sqlite3")).unwrap();
        conn.execute_batch(
            "CREATE TABLE assets (id TEXT PRIMARY KEY, file_path TEXT NOT NULL);
             INSERT INTO assets VALUES ('a', 'old.png');",
        )
        .unwrap();
    }
    let report = snapshot(&root);
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(report.dir.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["asset_count"], 1);
    assert_eq!(manifest["assets"][0]["file_path"], "old.png");
    assert!(manifest["assets"][0]["sha256"].is_null());
    std::fs::remove_dir_all(&root).ok();
}
