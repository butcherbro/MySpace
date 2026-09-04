//! Repository tests: load a board snapshot and create notes transactionally.

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::asset_service;
use myspace_lib::domain::models::{
    CreateImageCardInput, CreateNoteInput, Frame, ImportAssetInput, MoveCardItem, MoveCardsInput,
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
    asset_service::import_asset(
        &mut conn,
        &asset_dir,
        &ImportAssetInput {
            id: "img-asset-1".to_string(),
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
            asset_id: "img-asset-1".to_string(),
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
            assert_eq!(img.asset.id, "img-asset-1");
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
