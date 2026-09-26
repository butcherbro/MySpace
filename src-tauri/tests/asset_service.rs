//! Asset service tests: importing a file copies it into the asset dir and
//! records metadata, and is idempotent under replay.

use std::fs;

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::asset_service;
use myspace_lib::domain::models::{AssetDto, CreateFileCardInput, Frame, ImportAssetInput};

#[test]
fn import_asset_copies_file_and_records_metadata() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();

    let tmp = std::env::temp_dir().join(format!("myspace-asset-test-{}", uuid::Uuid::now_v7()));
    let asset_dir = tmp.join("assets");
    fs::create_dir_all(&asset_dir).unwrap();

    let source = tmp.join("source.png");
    fs::write(&source, b"fake-png-bytes").unwrap();

    let asset_id = uuid::Uuid::now_v7().to_string();
    let input = ImportAssetInput {
        id: asset_id.clone(),
        source_path: source.to_string_lossy().to_string(),
        file_name: "source.png".to_string(),
        mime_type: "image/png".to_string(),
    };

    let asset = asset_service::import_asset(&mut conn, &asset_dir, &input).unwrap();

    assert_eq!(asset.id, asset_id);
    assert_eq!(asset.file_name, "source.png");
    assert_eq!(asset.mime_type, "image/png");
    assert_eq!(asset.size_bytes, 14); // "fake-png-bytes"

    // The copied file exists at <asset_dir>/<id>.png.
    let copied = asset_dir.join(format!("{asset_id}.png"));
    assert!(copied.exists());
    assert_eq!(fs::read(&copied).unwrap(), b"fake-png-bytes");

    // Metadata was persisted.
    let loaded = asset_service::load_asset(&conn, &asset_id)
        .unwrap()
        .unwrap();
    assert_eq!(loaded.file_name, "source.png");

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn import_asset_is_idempotent_on_replay() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();

    let tmp = std::env::temp_dir().join(format!("myspace-asset-replay-{}", uuid::Uuid::now_v7()));
    let asset_dir = tmp.join("assets");
    fs::create_dir_all(&asset_dir).unwrap();
    let source = tmp.join("source.jpg");
    fs::write(&source, b"jpeg").unwrap();

    let asset_id = uuid::Uuid::now_v7().to_string();
    let input = ImportAssetInput {
        id: asset_id.clone(),
        source_path: source.to_string_lossy().to_string(),
        file_name: "source.jpg".to_string(),
        mime_type: "image/jpeg".to_string(),
    };

    let first = asset_service::import_asset(&mut conn, &asset_dir, &input).unwrap();
    let second = asset_service::import_asset(&mut conn, &asset_dir, &input).unwrap();
    assert_eq!(first, second);

    // No duplicate rows.
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM assets WHERE id = ?1",
            [asset_id.clone()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn import_asset_rejects_missing_source() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();

    let tmp = std::env::temp_dir().join(format!("myspace-asset-missing-{}", uuid::Uuid::now_v7()));
    let asset_dir = tmp.join("assets");
    fs::create_dir_all(&asset_dir).unwrap();

    let input = ImportAssetInput {
        id: uuid::Uuid::now_v7().to_string(),
        source_path: tmp.join("does-not-exist.png").to_string_lossy().to_string(),
        file_name: "missing.png".to_string(),
        mime_type: "image/png".to_string(),
    };

    assert!(asset_service::import_asset(&mut conn, &asset_dir, &input).is_err());

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn import_asset_rejects_non_uuid_id() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();

    let tmp =
        std::env::temp_dir().join(format!("myspace-asset-traversal-{}", uuid::Uuid::now_v7()));
    let asset_dir = tmp.join("assets");
    fs::create_dir_all(&asset_dir).unwrap();
    let source = tmp.join("source.png");
    fs::write(&source, b"png").unwrap();

    // A path-traversal id must be rejected before it is used to build a path.
    let input = ImportAssetInput {
        id: "../outside".to_string(),
        source_path: source.to_string_lossy().to_string(),
        file_name: "source.png".to_string(),
        mime_type: "image/png".to_string(),
    };
    assert!(matches!(
        asset_service::import_asset(&mut conn, &asset_dir, &input),
        Err(myspace_lib::domain::errors::WorkspaceError::ConstraintViolation(_))
    ));

    fs::remove_dir_all(&tmp).ok();
}

/// Contract test for the bounded preview: only the head of a large file is
/// returned, and nothing past the limit leaks into it. The allocation bound
/// itself is structural (`File::open().take(...)`), so it cannot be asserted
/// from the returned value.
#[test]
fn read_text_preview_reads_a_bounded_head_of_large_files() {
    let tmp = std::env::temp_dir().join(format!("myspace-preview-{}", uuid::Uuid::now_v7()));
    let asset_dir = tmp.join("assets");
    fs::create_dir_all(&asset_dir).unwrap();

    // 64 KiB of text with a marker placed well beyond the preview limit.
    let mut contents = vec![b'a'; 64 * 1024];
    let marker = b"BEYOND-THE-LIMIT";
    contents[32 * 1024..32 * 1024 + marker.len()].copy_from_slice(marker);
    fs::write(asset_dir.join("big.log"), &contents).unwrap();

    let asset = AssetDto {
        id: "preview-asset".to_string(),
        file_name: "big.log".to_string(),
        mime_type: "text/plain".to_string(),
        width: None,
        height: None,
        size_bytes: contents.len() as i64,
        file_path: "big.log".to_string(),
        sha256: None,
    };

    let limit = 8 * 1024;
    let preview = asset_service::read_text_preview(&asset_dir, &asset, limit);

    assert_eq!(
        preview.chars().count(),
        limit,
        "preview is capped at the limit"
    );
    assert!(
        !preview.contains("BEYOND-THE-LIMIT"),
        "the preview must not include content past the limit"
    );
    assert!(
        preview.chars().all(|c| c == 'a'),
        "the preview is the head of the file"
    );

    fs::remove_dir_all(&tmp).ok();
}

fn home_board_id(conn: &rusqlite::Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
}

fn asset_rows(conn: &rusqlite::Connection, id: &str) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM assets WHERE id = ?1", [id], |r| {
        r.get(0)
    })
    .unwrap()
}

fn file_card_input(card_id: &str, board_id: &str, source: &std::path::Path) -> CreateFileCardInput {
    CreateFileCardInput {
        id: card_id.to_string(),
        board_id: board_id.to_string(),
        frame: Frame {
            x: 0.0,
            y: 0.0,
            width: 280.0,
            height: 180.0,
        },
        z_index: 0,
        source_path: source.to_string_lossy().into_owned(),
        mime_type: "text/markdown".to_string(),
        file_name: "notes.md".to_string(),
    }
}

/// Stages one File Card asset and returns `(tmp, asset_dir, staged, input)`.
fn stage_one_file_card(
    conn: &rusqlite::Connection,
    label: &str,
) -> (
    std::path::PathBuf,
    std::path::PathBuf,
    asset_service::StagedAsset,
    CreateFileCardInput,
) {
    let tmp = std::env::temp_dir().join(format!("myspace-fc-{label}-{}", uuid::Uuid::now_v7()));
    let asset_dir = tmp.join("assets");
    fs::create_dir_all(&asset_dir).unwrap();
    let source = tmp.join("notes.md");
    fs::write(&source, b"# hello").unwrap();

    let asset_id = uuid::Uuid::now_v7().to_string();
    let staged = asset_service::stage_file_card_asset(
        &asset_dir,
        &asset_id,
        "notes.md",
        "text/markdown",
        &source.to_string_lossy(),
    )
    .unwrap();
    assert!(staged.file_abs.exists(), "staging writes the managed file");
    let input = file_card_input("fc-card", &home_board_id(conn), &source);
    (tmp, asset_dir, staged, input)
}

#[test]
fn commit_file_card_discards_staged_file_when_the_board_is_unknown() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let (tmp, _asset_dir, staged, _) = stage_one_file_card(&conn, "board");
    let source = tmp.join("notes.md");
    let input = file_card_input("fc-card", "does-not-exist", &source);

    let result = asset_service::commit_file_card(
        &mut conn,
        &input,
        &staged.asset,
        Some(&staged),
        "text",
        None,
    );

    assert!(result.is_err(), "an unknown board must fail the commit");
    assert!(
        !staged.file_abs.exists(),
        "the staged managed file is removed"
    );
    assert_eq!(
        asset_rows(&conn, &staged.asset.id),
        0,
        "no orphan asset row remains"
    );
    assert!(source.exists(), "the source file is never removed");
    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn commit_file_card_discards_staged_file_when_the_card_id_conflicts() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let (tmp, _asset_dir, staged, _) = stage_one_file_card(&conn, "conflict");
    let source = tmp.join("notes.md");
    let input = file_card_input("fc-card", &home_board_id(&conn), &source);

    // The id is already taken by a card of another kind.
    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at) VALUES ('fc-card', ?1, 'note', 0, 0, 200, 80, 0, 1, 0, 0)",
        [home_board_id(&conn)],
    )
    .unwrap();

    let result = asset_service::commit_file_card(
        &mut conn,
        &input,
        &staged.asset,
        Some(&staged),
        "text",
        None,
    );

    assert!(result.is_err(), "a kind conflict must fail the commit");
    assert!(!staged.file_abs.exists());
    assert_eq!(asset_rows(&conn, &staged.asset.id), 0);
    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn commit_file_card_discards_staged_file_when_the_asset_insert_fails() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let (tmp, _asset_dir, staged, _) = stage_one_file_card(&conn, "asset-insert");
    let source = tmp.join("notes.md");
    let input = file_card_input("fc-card", &home_board_id(&conn), &source);

    // A row with this asset id already exists, so the insert must fail.
    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at) VALUES (?1, 'other.md', 'text/markdown', 'other.md', NULL, NULL, 1, 0)",
        [staged.asset.id.clone()],
    )
    .unwrap();

    let result = asset_service::commit_file_card(
        &mut conn,
        &input,
        &staged.asset,
        Some(&staged),
        "text",
        None,
    );

    assert!(
        result.is_err(),
        "a duplicate asset row must fail the commit"
    );
    assert!(!staged.file_abs.exists());
    assert_eq!(
        asset_rows(&conn, &staged.asset.id),
        1,
        "only the pre-existing row"
    );
    assert_eq!(
        count_cards(&conn, "fc-card"),
        0,
        "the card rows rolled back with the asset insert"
    );
    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn a_failed_thumbnail_leaves_no_orphan_and_still_creates_the_card() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let (tmp, asset_dir, staged, _) = stage_one_file_card(&conn, "thumb");
    let source = tmp.join("notes.md");
    let input = file_card_input("fc-card", &home_board_id(&conn), &source);

    // Quick Look cannot render a missing file, so no thumbnail is staged.
    let thumbnail = asset_service::stage_thumbnail(&asset_dir, "/definitely/not/here.pdf");
    assert!(
        matches!(thumbnail, Ok(None)),
        "a failed thumbnail is not an error"
    );

    asset_service::commit_file_card(
        &mut conn,
        &input,
        &staged.asset,
        Some(&staged),
        "text",
        None,
    )
    .unwrap();

    assert!(staged.file_abs.exists(), "the card asset survives");
    assert_eq!(asset_rows(&conn, &staged.asset.id), 1);
    assert_eq!(count_cards(&conn, "fc-card"), 1);
    fs::remove_dir_all(&tmp).ok();
}

fn count_cards(conn: &rusqlite::Connection, id: &str) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM cards WHERE id = ?1", [id], |r| {
        r.get(0)
    })
    .unwrap()
}

// ---- P1.2: content hashes, dedup lookup, backfill ---------------------------

fn sha_of(bytes: &[u8]) -> String {
    asset_service::sha256_hex(bytes)
}

#[test]
fn sha256_hex_matches_a_known_vector() {
    assert_eq!(
        sha_of(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn every_stage_function_hashes_what_it_writes_and_the_row_keeps_it() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let tmp = std::env::temp_dir().join(format!("myspace-hash-{}", uuid::Uuid::now_v7()));
    let asset_dir = tmp.join("assets");
    fs::create_dir_all(&asset_dir).unwrap();

    // A source larger than one hashing chunk, to exercise the streamed copy.
    let big: Vec<u8> = (0..(600 * 1024)).map(|i| (i % 251) as u8).collect();
    let source = tmp.join("big.png");
    fs::write(&source, &big).unwrap();

    let image = asset_service::stage_image_asset(
        &asset_dir,
        &uuid::Uuid::now_v7().to_string(),
        "big.png",
        "image/png",
        &source.to_string_lossy(),
    )
    .unwrap();
    assert_eq!(image.asset.sha256.as_deref(), Some(sha_of(&big).as_str()));
    assert_eq!(image.asset.size_bytes, big.len() as i64);
    assert_eq!(fs::read(&image.file_abs).unwrap(), big);

    let file_card = asset_service::stage_file_card_asset(
        &asset_dir,
        &uuid::Uuid::now_v7().to_string(),
        "big.png",
        "image/png",
        &source.to_string_lossy(),
    )
    .unwrap();
    assert_eq!(file_card.asset.sha256, image.asset.sha256);

    let bytes = asset_service::stage_asset_bytes(&asset_dir, "x.png", "image/png", b"xyz").unwrap();
    assert_eq!(bytes.asset.sha256.as_deref(), Some(sha_of(b"xyz").as_str()));

    // insert_asset_row persists the hash; load_asset and the hash lookup see it.
    asset_service::insert_asset_row(&conn, &image.asset).unwrap();
    let loaded = asset_service::load_asset(&conn, &image.asset.id)
        .unwrap()
        .unwrap();
    assert_eq!(loaded.sha256, image.asset.sha256);
    let found = asset_service::find_asset_by_sha256(&conn, &sha_of(&big))
        .unwrap()
        .expect("found by hash");
    assert_eq!(found.id, image.asset.id);
    assert!(asset_service::find_asset_by_sha256(&conn, &sha_of(b"nope"))
        .unwrap()
        .is_none());

    // The direct-write helper hashes too.
    let stored =
        asset_service::store_asset_bytes(&mut conn, &asset_dir, "s.png", "image/png", b"stored")
            .unwrap();
    assert_eq!(
        asset_service::load_asset(&conn, &stored.id)
            .unwrap()
            .unwrap()
            .sha256
            .as_deref(),
        Some(sha_of(b"stored").as_str())
    );

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn asset_dto_without_sha256_still_deserialises() {
    let json = serde_json::json!({
        "id": "a", "fileName": "a.png", "mimeType": "image/png",
        "width": null, "height": null, "sizeBytes": 1, "filePath": "a.png"
    });
    let asset: AssetDto = serde_json::from_value(json).unwrap();
    assert_eq!(asset.sha256, None);
    let back = serde_json::to_value(&asset).unwrap();
    assert!(back.get("sha256").is_some(), "serialised as `sha256`");
}

#[test]
fn hash_existing_assets_backfills_null_rows_through_the_writer() {
    use myspace_lib::app::{Workspace, WorkspacePaths};
    use myspace_lib::domain::mutation::Mutation;

    let dir = std::env::temp_dir().join(format!("myspace-backfill-{}", uuid::Uuid::now_v7()));
    fs::create_dir_all(&dir).unwrap();
    let ws = Workspace::open(WorkspacePaths::new(&dir)).unwrap();
    let asset_dir = ws.paths().assets_dir();
    fs::create_dir_all(&asset_dir).unwrap();

    // More rows than one batch, all with NULL sha256; one file is missing and
    // one name is unsafe: both stay NULL.
    let total = asset_service::HASH_BACKFILL_BATCH + 5;
    {
        let conn = rusqlite::Connection::open(ws.paths().db_path()).unwrap();
        for i in 0..total {
            let id = format!("asset-{i:04}");
            let name = format!("{id}.bin");
            fs::write(asset_dir.join(&name), format!("bytes-{i}")).unwrap();
            conn.execute(
                "INSERT INTO assets (id, file_path, mime_type, file_name, size_bytes, created_at)
                 VALUES (?1, ?2, 'application/octet-stream', ?2, 1, 0)",
                rusqlite::params![id, name],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO assets (id, file_path, mime_type, file_name, size_bytes, created_at)
             VALUES ('gone', 'gone.bin', 'application/octet-stream', 'gone.bin', 1, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO assets (id, file_path, mime_type, file_name, size_bytes, created_at)
             VALUES ('unsafe', '../escape.bin', 'application/octet-stream', 'x', 1, 0)",
            [],
        )
        .unwrap();
    }

    let hashed = ws
        .apply_blocking(Mutation::HashExistingAssets)
        .unwrap()
        .into_count()
        .unwrap();
    assert_eq!(hashed, total as i64);

    let conn = rusqlite::Connection::open(ws.paths().db_path()).unwrap();
    let sha: String = conn
        .query_row(
            "SELECT sha256 FROM assets WHERE id = 'asset-0007'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(sha, sha_of(b"bytes-7"));
    let null_ids: Vec<String> = conn
        .prepare("SELECT id FROM assets WHERE sha256 IS NULL ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(null_ids, vec!["gone".to_string(), "unsafe".to_string()]);

    // Idempotent: a second run hashes nothing.
    let again = ws
        .apply_blocking(Mutation::HashExistingAssets)
        .unwrap()
        .into_count()
        .unwrap();
    assert_eq!(again, 0);
    assert_eq!(
        Mutation::HashExistingAssets.op_name(),
        "maintenance.hash_assets"
    );

    drop(ws);
    fs::remove_dir_all(&dir).ok();
}
