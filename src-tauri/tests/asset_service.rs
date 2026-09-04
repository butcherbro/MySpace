//! Asset service tests: importing a file copies it into the asset dir and
//! records metadata, and is idempotent under replay.

use std::fs;

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::asset_service;
use myspace_lib::domain::models::ImportAssetInput;

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
