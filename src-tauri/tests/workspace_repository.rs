//! Repository tests: load a board snapshot and create notes transactionally.

use myspace_lib::db::{bootstrap, open_in_memory};

#[test]
fn filesystem_alias_is_serialized_by_snapshot_and_read_card() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    let input = CreateFilesystemAliasInput {
        id: uuid::Uuid::now_v7().to_string(),
        board_id: home.clone(),
        frame: Frame {
            x: 1.0,
            y: 2.0,
            width: 280.0,
            height: 180.0,
        },
        z_index: 0,
        target_kind: "folder".into(),
        locator_blob: b"opaque".to_vec(),
        path_hint: "/display".into(),
        display_name: "Folder".into(),
    };
    workspace_repository::create_filesystem_alias(&mut conn, &input).unwrap();
    let snapshot = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert!(
        matches!(&snapshot.cards[0], CardDto::FilesystemAlias(alias) if alias.display_name == "Folder" && alias.path_hint == "/display")
    );
    assert!(matches!(
        workspace_repository::load_card(&conn, &input.id).unwrap(),
        CardDto::FilesystemAlias(_)
    ));
}

#[test]
fn stale_alias_refresh_replaces_authority_and_display_metadata_atomically() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = root_board_id(&conn);
    let id = uuid::Uuid::now_v7().to_string();
    workspace_repository::create_filesystem_alias(
        &mut conn,
        &CreateFilesystemAliasInput {
            id: id.clone(),
            board_id,
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 280.0,
                height: 180.0,
            },
            z_index: 0,
            target_kind: "folder".into(),
            locator_blob: b"old".to_vec(),
            path_hint: "/old".into(),
            display_name: "Old".into(),
        },
    )
    .unwrap();
    workspace_repository::refresh_filesystem_alias_locator(&mut conn, &id, b"new", "/new", "New")
        .unwrap();
    assert_eq!(
        workspace_repository::load_filesystem_alias_locator(&conn, &id).unwrap(),
        (b"new".to_vec(), "/new".into(), "New".into())
    );
}
use myspace_lib::domain::asset_service;
use myspace_lib::domain::models::{
    CardDto, CreateFilesystemAliasInput, CreateImageCardInput, CreateLinkBatchInput,
    CreateNoteInput, Frame, ImportAssetInput, LinkBatchItem, MoveCardItem, MoveCardsInput,
    UpdateCardFrameInput, UpdateNoteInput, UpdateViewportInput,
};
use myspace_lib::repositories::workspace_repository;

fn root_board_id(conn: &rusqlite::Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
}

fn card_count(conn: &rusqlite::Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0))
        .unwrap()
}

fn note_count(conn: &rusqlite::Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM note_cards", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn create_note_then_load_snapshot_roundtrips() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = root_board_id(&conn);

    let doc = serde_json::json!({"type":"doc","content":[{"type":"paragraph"}]});
    let input = CreateNoteInput {
        id: "note-1".to_string(),
        board_id: board_id.clone(),
        frame: Frame {
            x: 10.0,
            y: 20.0,
            width: 200.0,
            height: 80.0,
        },
        z_index: 0,
        document_json: doc.clone(),
        plain_text: "hello".to_string(),
    };
    workspace_repository::create_note(&mut conn, &input).unwrap();

    let snapshot = workspace_repository::load_board_snapshot(&conn, &board_id).unwrap();

    assert_eq!(snapshot.board.id, board_id);
    assert_eq!(snapshot.board.title, "Home");
    assert_eq!(snapshot.breadcrumbs.len(), 1);
    assert_eq!(snapshot.breadcrumbs[0].title, "Home");
    assert_eq!(snapshot.cards.len(), 1);

    let card = &snapshot.cards[0];
    match card {
        myspace_lib::domain::models::CardDto::Note(n) => {
            assert_eq!(n.id, "note-1");
            assert_eq!(n.frame.x, 10.0);
            assert_eq!(n.frame.y, 20.0);
            assert_eq!(n.frame.width, 200.0);
            assert_eq!(n.frame.height, 80.0);
            assert_eq!(n.plain_text, "hello");
            assert_eq!(n.document_json, doc);
            assert_eq!(n.revision, 1);
        }
        other => panic!("expected note card, got {other:?}"),
    }
}

#[test]
fn snapshot_serializes_as_camel_case() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = root_board_id(&conn);

    workspace_repository::create_note(
        &mut conn,
        &CreateNoteInput {
            id: "note-2".to_string(),
            board_id: board_id.clone(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 120.0,
                height: 48.0,
            },
            z_index: 1,
            document_json: serde_json::json!({"type":"doc"}),
            plain_text: "".to_string(),
        },
    )
    .unwrap();

    let snapshot = workspace_repository::load_board_snapshot(&conn, &board_id).unwrap();
    let json = serde_json::to_string(&snapshot).unwrap();

    // Assert camelCase keys appear and snake_case keys do not.
    assert!(json.contains("boardId"));
    assert!(json.contains("documentJson"));
    assert!(json.contains("zIndex"));
    assert!(json.contains("plainText"));
    assert!(!json.contains("board_id"));
    assert!(!json.contains("document_json"));
    assert!(!json.contains("z_index"));
    assert!(!json.contains("plain_text"));

    // Assert the card kind tag is exactly "note".
    assert!(
        json.contains("\"kind\":\"note\""),
        "kind tag missing: {json}"
    );
}

#[test]
fn failed_note_insert_leaves_no_orphan_card() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = root_board_id(&conn);

    assert_eq!(card_count(&conn), 0);
    assert_eq!(note_count(&conn), 0);

    // width below the 120 CHECK minimum must be rejected.
    let bad = CreateNoteInput {
        id: "note-bad".to_string(),
        board_id: board_id.clone(),
        frame: Frame {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 48.0,
        },
        z_index: 0,
        document_json: serde_json::json!({"type":"doc"}),
        plain_text: "".to_string(),
    };
    let result = workspace_repository::create_note(&mut conn, &bad);
    assert!(result.is_err(), "width violation must be rejected");

    // Neither the card nor the note row may be left behind.
    assert_eq!(card_count(&conn), 0, "orphan cards row must not remain");
    assert_eq!(
        note_count(&conn),
        0,
        "orphan note_cards row must not remain"
    );
}

#[test]
fn load_missing_board_returns_error() {
    let conn = open_in_memory().unwrap();
    let result = workspace_repository::load_board_snapshot(&conn, "does-not-exist");
    assert!(result.is_err());
}

#[test]
fn update_note_changes_content_and_bumps_revision() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = root_board_id(&conn);

    workspace_repository::create_note(
        &mut conn,
        &CreateNoteInput {
            id: "note-x".to_string(),
            board_id: board_id.clone(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 80.0,
            },
            z_index: 0,
            document_json: serde_json::json!({ "type": "doc" }),
            plain_text: "first".to_string(),
        },
    )
    .unwrap();

    workspace_repository::update_note(
        &mut conn,
        &UpdateNoteInput {
            id: "note-x".to_string(),
            expected_revision: 1,
            document_json: serde_json::json!({ "type": "doc", "content": [1] }),
            plain_text: "second".to_string(),
        },
    )
    .unwrap();

    let snapshot = workspace_repository::load_board_snapshot(&conn, &board_id).unwrap();
    match &snapshot.cards[0] {
        myspace_lib::domain::models::CardDto::Note(n) => {
            assert_eq!(n.plain_text, "second");
            assert_eq!(n.revision, 2);
        }
        other => panic!("expected note, got {other:?}"),
    }
}

#[test]
fn update_note_with_stale_revision_is_rejected() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = root_board_id(&conn);

    workspace_repository::create_note(
        &mut conn,
        &CreateNoteInput {
            id: "note-s".to_string(),
            board_id,
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 80.0,
            },
            z_index: 0,
            document_json: serde_json::json!({ "type": "doc" }),
            plain_text: "v1".to_string(),
        },
    )
    .unwrap();

    // First update from revision 1 -> 2 succeeds.
    workspace_repository::update_note(
        &mut conn,
        &UpdateNoteInput {
            id: "note-s".to_string(),
            expected_revision: 1,
            document_json: serde_json::json!({ "type": "doc" }),
            plain_text: "v2".to_string(),
        },
    )
    .unwrap();

    // A second update that still assumes revision 1 must be rejected as stale.
    let result = workspace_repository::update_note(
        &mut conn,
        &UpdateNoteInput {
            id: "note-s".to_string(),
            expected_revision: 1,
            document_json: serde_json::json!({ "type": "doc" }),
            plain_text: "should not apply".to_string(),
        },
    );
    assert!(matches!(
        result,
        Err(myspace_lib::domain::errors::WorkspaceError::StaleRevision { .. })
    ));
}

#[test]
fn move_card_updates_frame_and_bumps_revision() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = root_board_id(&conn);

    workspace_repository::create_note(
        &mut conn,
        &CreateNoteInput {
            id: "note-m".to_string(),
            board_id: board_id.clone(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 80.0,
            },
            z_index: 0,
            document_json: serde_json::json!({ "type": "doc" }),
            plain_text: "".to_string(),
        },
    )
    .unwrap();

    workspace_repository::update_card_frame(
        &mut conn,
        &UpdateCardFrameInput {
            id: "note-m".to_string(),
            expected_revision: 1,
            frame: Frame {
                x: 321.0,
                y: 123.0,
                width: 240.0,
                height: 120.0,
            },
        },
    )
    .unwrap();

    let snapshot = workspace_repository::load_board_snapshot(&conn, &board_id).unwrap();
    match &snapshot.cards[0] {
        myspace_lib::domain::models::CardDto::Note(n) => {
            assert_eq!(n.frame.x, 321.0);
            assert_eq!(n.frame.y, 123.0);
            assert_eq!(n.frame.width, 240.0);
            assert_eq!(n.frame.height, 120.0);
            assert_eq!(n.revision, 2);
        }
        other => panic!("expected note, got {other:?}"),
    }
}

#[test]
fn move_card_with_stale_revision_is_rejected() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = root_board_id(&conn);

    workspace_repository::create_note(
        &mut conn,
        &CreateNoteInput {
            id: "note-ms".to_string(),
            board_id,
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 80.0,
            },
            z_index: 0,
            document_json: serde_json::json!({ "type": "doc" }),
            plain_text: "".to_string(),
        },
    )
    .unwrap();

    workspace_repository::update_card_frame(
        &mut conn,
        &UpdateCardFrameInput {
            id: "note-ms".to_string(),
            expected_revision: 1,
            frame: Frame {
                x: 5.0,
                y: 5.0,
                width: 200.0,
                height: 80.0,
            },
        },
    )
    .unwrap();

    let result = workspace_repository::update_card_frame(
        &mut conn,
        &UpdateCardFrameInput {
            id: "note-ms".to_string(),
            expected_revision: 1,
            frame: Frame {
                x: 9.0,
                y: 9.0,
                width: 200.0,
                height: 80.0,
            },
        },
    );
    assert!(matches!(
        result,
        Err(myspace_lib::domain::errors::WorkspaceError::StaleRevision { .. })
    ));
}

#[test]
fn update_viewport_persists_and_bumps_revision() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = root_board_id(&conn);

    workspace_repository::update_viewport(
        &mut conn,
        &UpdateViewportInput {
            board_id: board_id.clone(),
            expected_revision: 1,
            x: 100.0,
            y: -50.0,
            zoom: 1.5,
        },
    )
    .unwrap();

    let snapshot = workspace_repository::load_board_snapshot(&conn, &board_id).unwrap();
    assert_eq!(snapshot.viewport.x, 100.0);
    assert_eq!(snapshot.viewport.y, -50.0);
    assert_eq!(snapshot.viewport.zoom, 1.5);
    assert_eq!(snapshot.viewport.revision, 2);
}

#[test]
fn update_viewport_with_stale_revision_is_rejected() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = root_board_id(&conn);

    workspace_repository::update_viewport(
        &mut conn,
        &UpdateViewportInput {
            board_id: board_id.clone(),
            expected_revision: 1,
            x: 1.0,
            y: 1.0,
            zoom: 1.0,
        },
    )
    .unwrap();

    let result = workspace_repository::update_viewport(
        &mut conn,
        &UpdateViewportInput {
            board_id: board_id.clone(),
            expected_revision: 1,
            x: 2.0,
            y: 2.0,
            zoom: 1.0,
        },
    );
    assert!(matches!(
        result,
        Err(myspace_lib::domain::errors::WorkspaceError::StaleRevision { .. })
    ));
}

#[test]
fn move_cards_moves_multiple_atomically() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = root_board_id(&conn);

    for (id, x) in [("n1", 0.0), ("n2", 100.0)] {
        workspace_repository::create_note(
            &mut conn,
            &CreateNoteInput {
                id: id.to_string(),
                board_id: board_id.clone(),
                frame: Frame {
                    x,
                    y: 0.0,
                    width: 200.0,
                    height: 80.0,
                },
                z_index: 0,
                document_json: serde_json::json!({ "type": "doc" }),
                plain_text: "".to_string(),
            },
        )
        .unwrap();
    }

    workspace_repository::move_cards(
        &mut conn,
        &MoveCardsInput {
            cards: vec![
                MoveCardItem {
                    id: "n1".to_string(),
                    expected_revision: 1,
                    frame: Frame {
                        x: 10.0,
                        y: 10.0,
                        width: 200.0,
                        height: 80.0,
                    },
                },
                MoveCardItem {
                    id: "n2".to_string(),
                    expected_revision: 1,
                    frame: Frame {
                        x: 20.0,
                        y: 20.0,
                        width: 200.0,
                        height: 80.0,
                    },
                },
            ],
        },
    )
    .unwrap();

    let snapshot = workspace_repository::load_board_snapshot(&conn, &board_id).unwrap();
    let mut xs: Vec<f64> = snapshot
        .cards
        .iter()
        .filter_map(|c| match c {
            myspace_lib::domain::models::CardDto::Note(n) => Some(n.frame.x),
            _ => None,
        })
        .collect();
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert_eq!(xs, vec![10.0, 20.0]);
}

#[test]
fn move_cards_rolls_back_whole_batch_on_stale_revision() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = root_board_id(&conn);

    for id in ["n1", "n2"] {
        workspace_repository::create_note(
            &mut conn,
            &CreateNoteInput {
                id: id.to_string(),
                board_id: board_id.clone(),
                frame: Frame {
                    x: 0.0,
                    y: 0.0,
                    width: 200.0,
                    height: 80.0,
                },
                z_index: 0,
                document_json: serde_json::json!({ "type": "doc" }),
                plain_text: "".to_string(),
            },
        )
        .unwrap();
    }

    workspace_repository::update_card_frame(
        &mut conn,
        &UpdateCardFrameInput {
            id: "n1".to_string(),
            expected_revision: 1,
            frame: Frame {
                x: 99.0,
                y: 99.0,
                width: 200.0,
                height: 80.0,
            },
        },
    )
    .unwrap();

    let result = workspace_repository::move_cards(
        &mut conn,
        &MoveCardsInput {
            cards: vec![
                MoveCardItem {
                    id: "n1".to_string(),
                    expected_revision: 1,
                    frame: Frame {
                        x: 500.0,
                        y: 500.0,
                        width: 200.0,
                        height: 80.0,
                    },
                },
                MoveCardItem {
                    id: "n2".to_string(),
                    expected_revision: 1,
                    frame: Frame {
                        x: 501.0,
                        y: 501.0,
                        width: 200.0,
                        height: 80.0,
                    },
                },
            ],
        },
    );
    assert!(matches!(
        result,
        Err(myspace_lib::domain::errors::WorkspaceError::StaleRevision { .. })
    ));

    let snapshot = workspace_repository::load_board_snapshot(&conn, &board_id).unwrap();
    let n2 = snapshot
        .cards
        .iter()
        .find_map(|c| match c {
            myspace_lib::domain::models::CardDto::Note(n) if n.id == "n2" => Some(n.frame.x),
            _ => None,
        })
        .unwrap();
    assert_eq!(n2, 0.0);
}

#[test]
fn create_image_card_then_load_snapshot_roundtrips() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = root_board_id(&conn);

    // Import an asset first (image cards reference a stored asset).
    let asset_dir =
        std::env::temp_dir().join(format!("myspace-img-asset-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&asset_dir).unwrap();
    let source = asset_dir.join("photo.png");
    std::fs::write(&source, b"png-bytes").unwrap();
    let asset_id = uuid::Uuid::now_v7().to_string();
    asset_service::import_asset(
        &mut conn,
        &asset_dir,
        &ImportAssetInput {
            id: asset_id.clone(),
            source_path: source.to_string_lossy().to_string(),
            file_name: "photo.png".to_string(),
            mime_type: "image/png".to_string(),
        },
    )
    .unwrap();

    workspace_repository::create_image_card(
        &mut conn,
        &CreateImageCardInput {
            id: "img-card-1".to_string(),
            board_id: board_id.clone(),
            frame: Frame {
                x: 50.0,
                y: 60.0,
                width: 320.0,
                height: 200.0,
            },
            z_index: 0,
            asset_id: asset_id.clone(),
            caption_json: serde_json::json!({"type": "doc"}),
            caption_plain_text: "".to_string(),
        },
    )
    .unwrap();

    let snapshot = workspace_repository::load_board_snapshot(&conn, &board_id).unwrap();
    match &snapshot.cards[0] {
        myspace_lib::domain::models::CardDto::Image(img) => {
            assert_eq!(img.id, "img-card-1");
            assert_eq!(img.frame.x, 50.0);
            assert_eq!(img.frame.height, 200.0);
            assert_eq!(img.asset.id, asset_id);
            assert_eq!(img.asset.file_name, "photo.png");
            assert_eq!(img.asset.mime_type, "image/png");
        }
        other => panic!("expected image card, got {other:?}"),
    }

    std::fs::remove_dir_all(&asset_dir).ok();
}

#[test]
fn create_image_card_with_unknown_asset_is_rejected() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = root_board_id(&conn);

    let result = workspace_repository::create_image_card(
        &mut conn,
        &CreateImageCardInput {
            id: "img-card-2".to_string(),
            board_id,
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 320.0,
                height: 200.0,
            },
            z_index: 0,
            asset_id: "does-not-exist".to_string(),
            caption_json: serde_json::json!({"type": "doc"}),
            caption_plain_text: "".to_string(),
        },
    );
    assert!(matches!(
        result,
        Err(myspace_lib::domain::errors::WorkspaceError::NotFound(_))
    ));

    assert_eq!(card_count(&conn), 0, "no orphan cards row on failed insert");
}

#[test]
fn update_image_caption_persists_and_bumps_revision() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = root_board_id(&conn);

    let asset_dir = std::env::temp_dir().join(format!("myspace-img-cap-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&asset_dir).unwrap();
    let source = asset_dir.join("photo.png");
    std::fs::write(&source, b"png").unwrap();
    let asset_id = uuid::Uuid::now_v7().to_string();
    asset_service::import_asset(
        &mut conn,
        &asset_dir,
        &ImportAssetInput {
            id: asset_id.clone(),
            source_path: source.to_string_lossy().to_string(),
            file_name: "photo.png".to_string(),
            mime_type: "image/png".to_string(),
        },
    )
    .unwrap();

    workspace_repository::create_image_card(
        &mut conn,
        &CreateImageCardInput {
            id: "cap-card-1".to_string(),
            board_id: board_id.clone(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 320.0,
                height: 200.0,
            },
            z_index: 0,
            asset_id,
            caption_json: serde_json::json!({ "type": "doc" }),
            caption_plain_text: "".to_string(),
        },
    )
    .unwrap();

    workspace_repository::update_image_caption(
        &mut conn,
        &myspace_lib::domain::models::UpdateImageCaptionInput {
            id: "cap-card-1".to_string(),
            expected_revision: 1,
            caption_json: serde_json::json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "hello caption"}]}]}),
            caption_plain_text: "hello caption".to_string(),
        },
    )
    .unwrap();

    let snapshot = workspace_repository::load_board_snapshot(&conn, &board_id).unwrap();
    match &snapshot.cards[0] {
        myspace_lib::domain::models::CardDto::Image(img) => {
            assert_eq!(img.caption_plain_text, "hello caption");
            assert_eq!(img.revision, 2);
        }
        other => panic!("expected image card, got {other:?}"),
    }

    std::fs::remove_dir_all(&asset_dir).ok();
}

#[test]
fn move_card_to_board_changes_board_and_resets_position() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    myspace_lib::domain::board_service::create_child_board(
        &mut conn,
        &myspace_lib::domain::models::CreateChildBoardInput {
            parent_board_id: home.clone(),
            board_id: "target-b".to_string(),
            portal_card_id: "target-p".to_string(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 120.0,
                height: 112.0,
            },
            title: "Target".to_string(),
        },
    )
    .unwrap();

    workspace_repository::create_note(
        &mut conn,
        &CreateNoteInput {
            id: "note-mv".to_string(),
            board_id: home.clone(),
            frame: Frame {
                x: 500.0,
                y: 500.0,
                width: 200.0,
                height: 80.0,
            },
            z_index: 0,
            document_json: serde_json::json!({ "type": "doc" }),
            plain_text: "".to_string(),
        },
    )
    .unwrap();

    workspace_repository::move_card_to_board(
        &mut conn,
        &myspace_lib::domain::models::MoveCardToBoardInput {
            id: "note-mv".to_string(),
            expected_revision: 1,
            target_board_id: "target-b".to_string(),
            frame: None,
        },
    )
    .unwrap();

    let home_snap = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert!(!home_snap.cards.iter().any(|c| c.id() == "note-mv"));

    let target_snap = workspace_repository::load_board_snapshot(&conn, "target-b").unwrap();
    match target_snap.cards.iter().find(|c| c.id() == "note-mv") {
        Some(myspace_lib::domain::models::CardDto::Note(n)) => {
            assert_eq!(n.frame.x, 40.0);
            assert_eq!(n.frame.y, 40.0);
            assert_eq!(n.revision, 2);
        }
        other => panic!("expected moved note on target, got {other:?}"),
    }
}

#[test]
fn move_card_to_board_places_card_at_requested_frame() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    myspace_lib::domain::board_service::create_child_board(
        &mut conn,
        &myspace_lib::domain::models::CreateChildBoardInput {
            parent_board_id: home.clone(),
            board_id: "target-b".to_string(),
            portal_card_id: "target-p".to_string(),
            frame: myspace_lib::domain::models::Frame {
                x: 0.0,
                y: 0.0,
                width: 120.0,
                height: 112.0,
            },
            title: "Target".to_string(),
        },
    )
    .unwrap();

    workspace_repository::create_note(
        &mut conn,
        &CreateNoteInput {
            id: "note-mv3".to_string(),
            board_id: home.clone(),
            frame: Frame {
                x: 10.0,
                y: 20.0,
                width: 200.0,
                height: 80.0,
            },
            z_index: 0,
            document_json: serde_json::json!({ "type": "doc" }),
            plain_text: "".to_string(),
        },
    )
    .unwrap();

    workspace_repository::move_card_to_board(
        &mut conn,
        &myspace_lib::domain::models::MoveCardToBoardInput {
            id: "note-mv3".to_string(),
            expected_revision: 1,
            target_board_id: "target-b".to_string(),
            frame: Some(myspace_lib::domain::models::Frame {
                x: 320.0,
                y: 240.0,
                width: 200.0,
                height: 80.0,
            }),
        },
    )
    .unwrap();

    let target_snap = workspace_repository::load_board_snapshot(&conn, "target-b").unwrap();
    match target_snap.cards.iter().find(|c| c.id() == "note-mv3") {
        Some(myspace_lib::domain::models::CardDto::Note(n)) => {
            assert_eq!(n.frame.x, 320.0);
            assert_eq!(n.frame.y, 240.0);
            assert_eq!(n.frame.width, 200.0);
            assert_eq!(n.frame.height, 80.0);
        }
        other => panic!("expected moved note on target, got {other:?}"),
    }
}

#[test]
fn move_card_to_board_rejects_unknown_target() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    workspace_repository::create_note(
        &mut conn,
        &CreateNoteInput {
            id: "note-mv2".to_string(),
            board_id: home.clone(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 80.0,
            },
            z_index: 0,
            document_json: serde_json::json!({ "type": "doc" }),
            plain_text: "".to_string(),
        },
    )
    .unwrap();

    let result = workspace_repository::move_card_to_board(
        &mut conn,
        &myspace_lib::domain::models::MoveCardToBoardInput {
            id: "note-mv2".to_string(),
            expected_revision: 1,
            target_board_id: "does-not-exist".to_string(),
            frame: None,
        },
    );
    assert!(matches!(
        result,
        Err(myspace_lib::domain::errors::WorkspaceError::NotFound(_))
    ));
}

fn create_test_note(conn: &mut rusqlite::Connection) -> String {
    let board_id = root_board_id(conn);
    workspace_repository::create_note(
        conn,
        &CreateNoteInput {
            id: "note-to-embed".to_string(),
            board_id: board_id.clone(),
            frame: Frame {
                x: 77.0,
                y: 88.0,
                width: 200.0,
                height: 80.0,
            },
            z_index: 3,
            document_json: serde_json::json!({ "type": "doc" }),
            plain_text: "https://example.com".to_string(),
        },
    )
    .unwrap();
    board_id
}

#[test]
fn convert_note_to_embed_preserves_identity_and_kind() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = create_test_note(&mut conn);

    let embed = workspace_repository::convert_note_to_embed(
        &mut conn,
        &myspace_lib::domain::models::ConvertNoteToEmbedInput {
            id: "note-to-embed".to_string(),
            expected_revision: 1,
            source_url: "https://example.com".to_string(),
            display_url: "example.com".to_string(),
            title: "https://example.com".to_string(),
            description_json: serde_json::json!({ "type": "doc" }),
            description_plain_text: "".to_string(),
        },
    )
    .unwrap();

    assert_eq!(embed.id, "note-to-embed");
    assert_eq!(embed.board_id, board_id);
    assert_eq!(embed.frame.x, 77.0);
    assert_eq!(embed.frame.y, 88.0);
    assert_eq!(embed.z_index, 3);
    assert_eq!(embed.revision, 2); // bumped from 1
    assert_eq!(embed.source_url, "https://example.com");
    assert_eq!(embed.display_url, "example.com");
    assert_eq!(embed.title, "https://example.com");
    assert_eq!(embed.metadata_status, "pending");
    assert_eq!(embed.preview_asset, None);
    assert_eq!(embed.favicon_asset, None);
    assert_eq!(embed.preview_origin, None);

    // The note storage is gone and the card is now an embed.
    assert_eq!(note_count(&conn), 0);
    let kind: String = conn
        .query_row(
            "SELECT kind FROM cards WHERE id = 'note-to-embed'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(kind, "embed");
}

#[test]
fn convert_note_to_embed_roundtrips_through_snapshot() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = create_test_note(&mut conn);

    workspace_repository::convert_note_to_embed(
        &mut conn,
        &myspace_lib::domain::models::ConvertNoteToEmbedInput {
            id: "note-to-embed".to_string(),
            expected_revision: 1,
            source_url: "https://example.com".to_string(),
            display_url: "example.com".to_string(),
            title: "https://example.com".to_string(),
            description_json: serde_json::json!({ "type": "doc" }),
            description_plain_text: "".to_string(),
        },
    )
    .unwrap();

    let snapshot = workspace_repository::load_board_snapshot(&conn, &board_id).unwrap();
    assert_eq!(snapshot.cards.len(), 1);
    match &snapshot.cards[0] {
        myspace_lib::domain::models::CardDto::Embed(e) => {
            assert_eq!(e.id, "note-to-embed");
            assert_eq!(e.source_url, "https://example.com");
            assert_eq!(e.metadata_status, "pending");
        }
        other => panic!("expected embed card, got {other:?}"),
    }
}

#[test]
fn convert_note_to_embed_rejects_stale_revision() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    create_test_note(&mut conn);

    let result = workspace_repository::convert_note_to_embed(
        &mut conn,
        &myspace_lib::domain::models::ConvertNoteToEmbedInput {
            id: "note-to-embed".to_string(),
            expected_revision: 99,
            source_url: "https://example.com".to_string(),
            display_url: "example.com".to_string(),
            title: "https://example.com".to_string(),
            description_json: serde_json::json!({ "type": "doc" }),
            description_plain_text: "".to_string(),
        },
    );
    assert!(matches!(
        result,
        Err(myspace_lib::domain::errors::WorkspaceError::StaleRevision { expected: 99, .. })
    ));
    // Still a note, untouched.
    assert_eq!(note_count(&conn), 1);
}

#[test]
fn convert_note_to_embed_errors_on_non_note() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = root_board_id(&conn);

    // Create a second note and convert it; then converting again must fail.
    workspace_repository::create_note(
        &mut conn,
        &CreateNoteInput {
            id: "twice".to_string(),
            board_id: board_id.clone(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 80.0,
            },
            z_index: 0,
            document_json: serde_json::json!({ "type": "doc" }),
            plain_text: "".to_string(),
        },
    )
    .unwrap();
    let input = myspace_lib::domain::models::ConvertNoteToEmbedInput {
        id: "twice".to_string(),
        expected_revision: 1,
        source_url: "https://example.com".to_string(),
        display_url: "example.com".to_string(),
        title: "https://example.com".to_string(),
        description_json: serde_json::json!({ "type": "doc" }),
        description_plain_text: "".to_string(),
    };
    workspace_repository::convert_note_to_embed(&mut conn, &input).unwrap();

    // Re-conversion uses a bumped revision and must be rejected (kind != note).
    let again = myspace_lib::domain::models::ConvertNoteToEmbedInput {
        expected_revision: 2,
        ..input.clone()
    };
    assert!(matches!(
        workspace_repository::convert_note_to_embed(&mut conn, &again),
        Err(myspace_lib::domain::errors::WorkspaceError::ConstraintViolation(_))
    ));
}

#[test]
fn breadcrumbs_are_root_to_leaf() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    // Home -> A -> B
    myspace_lib::domain::board_service::create_child_board(
        &mut conn,
        &myspace_lib::domain::models::CreateChildBoardInput {
            parent_board_id: home.clone(),
            board_id: "a".to_string(),
            portal_card_id: "p-a".to_string(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 120.0,
                height: 112.0,
            },
            title: "A".to_string(),
        },
    )
    .unwrap();
    myspace_lib::domain::board_service::create_child_board(
        &mut conn,
        &myspace_lib::domain::models::CreateChildBoardInput {
            parent_board_id: "a".to_string(),
            board_id: "b".to_string(),
            portal_card_id: "p-b".to_string(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 120.0,
                height: 112.0,
            },
            title: "B".to_string(),
        },
    )
    .unwrap();

    let snapshot = workspace_repository::load_board_snapshot(&conn, "b").unwrap();
    let ids: Vec<&str> = snapshot.breadcrumbs.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, vec![home.as_str(), "a", "b"]);
    let titles: Vec<&str> = snapshot
        .breadcrumbs
        .iter()
        .map(|c| c.title.as_str())
        .collect();
    assert_eq!(titles, vec!["Home", "A", "B"]);
}

#[test]
fn home_breadcrumbs_contain_only_home() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    let snapshot = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    let ids: Vec<&str> = snapshot.breadcrumbs.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, vec![home.as_str()]);
}

#[test]
fn create_link_batch_creates_links_and_is_idempotent() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    let input = CreateLinkBatchInput {
        idempotency_key: "req-1".to_string(),
        board_id: home.clone(),
        links: vec![
            LinkBatchItem {
                id: "l1".to_string(),
                source_url: "https://a.com".to_string(),
                title: "A".to_string(),
                description: "".to_string(),
            },
            LinkBatchItem {
                id: "l2".to_string(),
                source_url: "https://b.com".to_string(),
                title: "B".to_string(),
                description: "".to_string(),
            },
        ],
    };

    let first = workspace_repository::create_link_batch(&mut conn, &input).unwrap();
    assert_eq!(first.card_ids.len(), 2);
    assert!(!first.batch_id.is_empty());

    // Two embed cards exist.
    let embed_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM cards WHERE kind = 'embed'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(embed_count, 2);

    // Replaying the same idempotency key returns the same result, no duplicates.
    let replay = workspace_repository::create_link_batch(&mut conn, &input).unwrap();
    assert_eq!(replay.batch_id, first.batch_id);
    assert_eq!(replay.card_ids, first.card_ids);
    let embed_count_after: i64 = conn
        .query_row("SELECT COUNT(*) FROM cards WHERE kind = 'embed'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(embed_count_after, 2);
}

#[test]
fn create_link_batch_rejects_unknown_board() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();

    let result = workspace_repository::create_link_batch(
        &mut conn,
        &CreateLinkBatchInput {
            idempotency_key: "req-2".to_string(),
            board_id: "does-not-exist".to_string(),
            links: vec![LinkBatchItem {
                id: "l1".to_string(),
                source_url: "https://a.com".to_string(),
                title: "A".to_string(),
                description: "".to_string(),
            }],
        },
    );
    assert!(matches!(
        result,
        Err(myspace_lib::domain::errors::WorkspaceError::NotFound(_))
    ));
}

#[test]
fn move_cards_to_board_unsorted_batches_and_hides_from_canvas() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    myspace_lib::domain::board_service::create_child_board(
        &mut conn,
        &myspace_lib::domain::models::CreateChildBoardInput {
            parent_board_id: home.clone(),
            board_id: "target-b".to_string(),
            portal_card_id: "target-p".to_string(),
            frame: myspace_lib::domain::models::Frame {
                x: 0.0,
                y: 0.0,
                width: 120.0,
                height: 112.0,
            },
            title: "Target".to_string(),
        },
    )
    .unwrap();

    for id in ["n1", "n2"] {
        workspace_repository::create_note(
            &mut conn,
            &CreateNoteInput {
                id: id.to_string(),
                board_id: home.clone(),
                frame: Frame {
                    x: 10.0,
                    y: 20.0,
                    width: 200.0,
                    height: 80.0,
                },
                z_index: 0,
                document_json: serde_json::json!({ "type": "doc" }),
                plain_text: "".to_string(),
            },
        )
        .unwrap();
    }

    workspace_repository::move_cards_to_board_unsorted(
        &mut conn,
        &myspace_lib::domain::models::MoveCardsToUnsortedInput {
            target_board_id: "target-b".to_string(),
            cards: vec![
                myspace_lib::domain::models::MoveCardToUnsortedItem {
                    id: "n1".to_string(),
                    expected_revision: 1,
                },
                myspace_lib::domain::models::MoveCardToUnsortedItem {
                    id: "n2".to_string(),
                    expected_revision: 1,
                },
            ],
        },
    )
    .unwrap();

    // The target board's canvas has no cards; both are in Unsorted.
    let snap = workspace_repository::load_board_snapshot(&conn, "target-b").unwrap();
    assert!(snap.cards.is_empty());
    assert_eq!(snap.unsorted_cards.len(), 2);
    assert!(snap
        .unsorted_cards
        .iter()
        .all(|c| c.id() == "n1" || c.id() == "n2"));

    // Home no longer shows them on canvas either.
    let home_snap = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert!(!home_snap
        .cards
        .iter()
        .any(|c| c.id() == "n1" || c.id() == "n2"));
}

#[test]
fn move_cards_to_board_unsorted_rejects_stale_revision_atomically() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    myspace_lib::domain::board_service::create_child_board(
        &mut conn,
        &myspace_lib::domain::models::CreateChildBoardInput {
            parent_board_id: home.clone(),
            board_id: "target-b".to_string(),
            portal_card_id: "target-p".to_string(),
            frame: myspace_lib::domain::models::Frame {
                x: 0.0,
                y: 0.0,
                width: 120.0,
                height: 112.0,
            },
            title: "Target".to_string(),
        },
    )
    .unwrap();

    for id in ["n1", "n2"] {
        workspace_repository::create_note(
            &mut conn,
            &CreateNoteInput {
                id: id.to_string(),
                board_id: home.clone(),
                frame: Frame {
                    x: 10.0,
                    y: 20.0,
                    width: 200.0,
                    height: 80.0,
                },
                z_index: 0,
                document_json: serde_json::json!({ "type": "doc" }),
                plain_text: "".to_string(),
            },
        )
        .unwrap();
    }

    // n2 has a stale expected revision -> the whole batch is rejected.
    let result = workspace_repository::move_cards_to_board_unsorted(
        &mut conn,
        &myspace_lib::domain::models::MoveCardsToUnsortedInput {
            target_board_id: "target-b".to_string(),
            cards: vec![
                myspace_lib::domain::models::MoveCardToUnsortedItem {
                    id: "n1".to_string(),
                    expected_revision: 1,
                },
                myspace_lib::domain::models::MoveCardToUnsortedItem {
                    id: "n2".to_string(),
                    expected_revision: 99,
                },
            ],
        },
    );
    assert!(matches!(
        result,
        Err(myspace_lib::domain::errors::WorkspaceError::StaleRevision { expected: 99, .. })
    ));

    // Nothing moved: both cards are still on Home's canvas.
    let home_snap = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert!(home_snap.cards.iter().any(|c| c.id() == "n1"));
    assert!(home_snap.cards.iter().any(|c| c.id() == "n2"));
}

#[test]
fn place_unsorted_card_puts_it_on_canvas_at_frame() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    workspace_repository::create_note(
        &mut conn,
        &CreateNoteInput {
            id: "n1".to_string(),
            board_id: home.clone(),
            frame: Frame {
                x: 10.0,
                y: 20.0,
                width: 200.0,
                height: 80.0,
            },
            z_index: 0,
            document_json: serde_json::json!({ "type": "doc" }),
            plain_text: "".to_string(),
        },
    )
    .unwrap();

    // Mark it unsorted first.
    workspace_repository::move_cards_to_board_unsorted(
        &mut conn,
        &myspace_lib::domain::models::MoveCardsToUnsortedInput {
            target_board_id: home.clone(),
            cards: vec![myspace_lib::domain::models::MoveCardToUnsortedItem {
                id: "n1".to_string(),
                expected_revision: 1,
            }],
        },
    )
    .unwrap();

    workspace_repository::place_unsorted_card(
        &mut conn,
        &myspace_lib::domain::models::PlaceUnsortedCardInput {
            id: "n1".to_string(),
            expected_revision: 2,
            frame: Frame {
                x: 320.0,
                y: 240.0,
                width: 200.0,
                height: 80.0,
            },
        },
    )
    .unwrap();

    let snap = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert!(snap.unsorted_cards.is_empty());
    match snap.cards.iter().find(|c| c.id() == "n1") {
        Some(myspace_lib::domain::models::CardDto::Note(n)) => {
            assert_eq!(n.frame.x, 320.0);
            assert_eq!(n.frame.y, 240.0);
        }
        other => panic!("expected placed note, got {other:?}"),
    }
}

#[test]
fn file_card_roundtrips_through_snapshot_and_read_card() {
    use myspace_lib::domain::models::{CreateFileCardInput, FileCardDto};
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = root_board_id(&conn);
    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at) VALUES ('fa', 'x.txt', 'text/plain', 'notes.txt', NULL, NULL, 10, 0)",
        [],
    )
    .unwrap();
    let tx = conn.transaction().unwrap();
    workspace_repository::insert_file_card_rows(
        &tx,
        &CreateFileCardInput {
            id: "fc".into(),
            board_id: board_id.clone(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 280.0,
                height: 180.0,
            },
            z_index: 0,
            source_path: "/tmp/notes.txt".into(),
            mime_type: "text/plain".into(),
            file_name: "notes.txt".into(),
        },
        "fa",
        "hello preview",
        None,
    )
    .unwrap();
    tx.commit().unwrap();
    let snapshot = workspace_repository::load_board_snapshot(&conn, &board_id).unwrap();
    let file = snapshot.cards.iter().find_map(|c| match c {
        CardDto::File(f) if f.id == "fc" => Some(f),
        _ => None,
    });
    assert!(file.is_some());
    let file = file.unwrap();
    assert_eq!(file.preview_text, "hello preview");
    assert_eq!(file.asset.file_name, "notes.txt");
    assert!(matches!(
        workspace_repository::load_card(&conn, "fc").unwrap(),
        CardDto::File(FileCardDto { .. })
    ));
}

#[test]
fn file_card_projection_carries_the_generated_thumbnail() {
    // The create command returns the persisted projection, so a generated
    // thumbnail must already be in it (and agree with the board snapshot) instead
    // of the frontend having to reload the card.
    use myspace_lib::domain::models::{CreateFileCardInput, FileCardDto};
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let board_id = root_board_id(&conn);

    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at) VALUES ('fa', 'x.pdf', 'application/pdf', 'report.pdf', NULL, NULL, 10, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at) VALUES ('thumb', 'thumb.png', 'image/png', 'thumbnail.png', 256, 256, 4, 0)",
        [],
    )
    .unwrap();

    let tx = conn.transaction().unwrap();
    workspace_repository::insert_file_card_rows(
        &tx,
        &CreateFileCardInput {
            id: "fc".into(),
            board_id: board_id.clone(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 280.0,
                height: 180.0,
            },
            z_index: 0,
            source_path: "/tmp/report.pdf".into(),
            mime_type: "application/pdf".into(),
            file_name: "report.pdf".into(),
        },
        "fa",
        "(office document)",
        Some("thumb"),
    )
    .unwrap();
    tx.commit().unwrap();

    let loaded = workspace_repository::load_card(&conn, "fc").unwrap();
    let CardDto::File(FileCardDto { preview_asset, .. }) = loaded else {
        panic!("expected a File Card projection");
    };
    let preview = preview_asset.expect("the generated thumbnail is projected");
    assert_eq!(preview.id, "thumb");
    assert_eq!(preview.mime_type, "image/png");

    // The board snapshot projection must agree with the single-card projection.
    let snapshot = workspace_repository::load_board_snapshot(&conn, &board_id).unwrap();
    let from_snapshot = snapshot.cards.iter().find_map(|c| match c {
        CardDto::File(f) if f.id == "fc" => Some(f.preview_asset.clone()),
        _ => None,
    });
    assert_eq!(
        from_snapshot.flatten().map(|asset| asset.id),
        Some("thumb".to_string())
    );
}
