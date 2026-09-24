//! Trash lifecycle: recursive subtree soft-delete and batch restore.

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::board_service;
use myspace_lib::domain::models::{
    CreateChildBoardInput, CreateFilesystemAliasInput, CreateNoteInput, Frame, TrashItem,
    TrashSelectionInput,
};
use myspace_lib::domain::trash_service;
use myspace_lib::repositories::workspace_repository;

fn root_board_id(conn: &rusqlite::Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
}

#[test]
fn trash_and_restore_folder_alias_preserves_detail_identity() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    workspace_repository::create_filesystem_alias(
        &mut conn,
        &CreateFilesystemAliasInput {
            id: "folder-trash".into(),
            board_id: home.clone(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 360.0,
                height: 300.0,
            },
            z_index: 0,
            target_kind: "folder".into(),
            locator_blob: vec![9, 8, 7],
            path_hint: "/Volumes/Studio/Video project".into(),
            display_name: "Video project".into(),
        },
    )
    .unwrap();

    let batch_id = trash_service::trash_selection(
        &mut conn,
        &TrashSelectionInput {
            items: vec![TrashItem {
                id: "folder-trash".into(),
                kind: "filesystem_alias".into(),
            }],
        },
    )
    .unwrap();
    let summary = trash_service::list_trash(&conn).unwrap();
    assert_eq!(summary.batches[0].items[0].kind, "filesystem_alias");
    assert_eq!(summary.batches[0].items[0].title, "Video project");

    trash_service::restore_trash_batch(&mut conn, &batch_id).unwrap();
    assert!(matches!(
        workspace_repository::load_card(&conn, "folder-trash").unwrap(),
        myspace_lib::domain::models::CardDto::FilesystemAlias(alias)
            if alias.path_hint == "/Volumes/Studio/Video project"
    ));
    assert_eq!(
        workspace_repository::load_filesystem_alias_locator(&conn, "folder-trash")
            .unwrap()
            .0,
        vec![9, 8, 7],
    );
}

fn child_input(parent: &str, board_id: &str, portal_id: &str) -> CreateChildBoardInput {
    CreateChildBoardInput {
        parent_board_id: parent.to_string(),
        board_id: board_id.to_string(),
        portal_card_id: portal_id.to_string(),
        frame: Frame {
            x: 0.0,
            y: 0.0,
            width: 120.0,
            height: 112.0,
        },
        title: "Child".to_string(),
    }
}

fn active_board_count(conn: &rusqlite::Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM boards WHERE deleted_at IS NULL",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

fn trashed_board_count(conn: &rusqlite::Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM boards WHERE deleted_at IS NOT NULL",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn trash_child_board_marks_subtree_and_portal() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    // home -> child b1 -> grandchild b2
    board_service::create_child_board(&mut conn, &child_input(&home, "b1", "p1")).unwrap();
    board_service::create_child_board(&mut conn, &child_input("b1", "b2", "p2")).unwrap();
    assert_eq!(active_board_count(&conn), 3);

    // Trash b1: b1 and b2 (subtree) become trashed; Home stays active.
    trash_service::trash_board(&mut conn, "b1").unwrap();

    assert_eq!(active_board_count(&conn), 1, "only Home remains active");
    assert_eq!(trashed_board_count(&conn), 2, "b1 and b2 are trashed");

    // The portal card p1 (on Home pointing to b1) is also trashed.
    let portal_deleted: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE id = 'p1' AND deleted_at IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(portal_deleted, 1, "portal p1 must be trashed");
}

#[test]
fn trash_root_board_is_rejected() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    let result = trash_service::trash_board(&mut conn, &home);
    assert!(result.is_err());
    assert_eq!(active_board_count(&conn), 1);
}

#[test]
fn active_snapshot_excludes_trashed_subtree() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    board_service::create_child_board(&mut conn, &child_input(&home, "b1", "p1")).unwrap();
    trash_service::trash_board(&mut conn, "b1").unwrap();

    // Home's snapshot must no longer show the trashed portal p1.
    let snapshot = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert!(
        !snapshot.cards.iter().any(|c| c.id() == "p1"),
        "trashed portal must not appear in snapshot"
    );
}

#[test]
fn restore_trash_batch_restores_subtree_and_portal() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    board_service::create_child_board(&mut conn, &child_input(&home, "b1", "p1")).unwrap();
    board_service::create_child_board(&mut conn, &child_input("b1", "b2", "p2")).unwrap();

    let batch_id = trash_service::trash_board(&mut conn, "b1").unwrap();
    assert_eq!(active_board_count(&conn), 1);

    trash_service::restore_trash_batch(&mut conn, &batch_id).unwrap();

    assert_eq!(active_board_count(&conn), 3, "subtree fully restored");
    assert_eq!(trashed_board_count(&conn), 0);

    // The portal p1 is visible again on Home.
    let snapshot = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert!(snapshot.cards.iter().any(|c| c.id() == "p1"));
}

#[test]
fn trash_selection_atomically_trashes_leaf_and_board() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    // A note card on Home, and a child board (b1) with its portal.
    workspace_repository::create_note(
        &mut conn,
        &CreateNoteInput {
            id: "note-sel".to_string(),
            board_id: home.clone(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 80.0,
            },
            z_index: 0,
            document_json: serde_json::json!({ "type": "doc" }),
        },
    )
    .unwrap();
    board_service::create_child_board(&mut conn, &child_input(&home, "bsel", "psel")).unwrap();

    // Trash note + board in one selection.
    let batch = trash_service::trash_selection(
        &mut conn,
        &TrashSelectionInput {
            items: vec![
                TrashItem {
                    id: "note-sel".to_string(),
                    kind: "note".to_string(),
                },
                TrashItem {
                    id: "bsel".to_string(),
                    kind: "board_portal".to_string(),
                },
            ],
        },
    )
    .unwrap();

    // Both are gone from the active snapshot.
    let snapshot = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert!(!snapshot
        .cards
        .iter()
        .any(|c| c.id() == "note-sel" || c.id() == "psel"));

    // Restore brings both back.
    trash_service::restore_trash_batch(&mut conn, &batch).unwrap();
    let snapshot = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert!(snapshot.cards.iter().any(|c| c.id() == "note-sel"));
    assert!(snapshot.cards.iter().any(|c| c.id() == "psel"));
}

#[test]
fn trash_selection_rolls_back_on_bad_item() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    workspace_repository::create_note(
        &mut conn,
        &CreateNoteInput {
            id: "note-ok".to_string(),
            board_id: home.clone(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 80.0,
            },
            z_index: 0,
            document_json: serde_json::json!({ "type": "doc" }),
        },
    )
    .unwrap();

    // First item valid, second references a missing card -> whole batch rolls back.
    let result = trash_service::trash_selection(
        &mut conn,
        &TrashSelectionInput {
            items: vec![
                TrashItem {
                    id: "note-ok".to_string(),
                    kind: "note".to_string(),
                },
                TrashItem {
                    id: "missing".to_string(),
                    kind: "note".to_string(),
                },
            ],
        },
    );
    assert!(matches!(
        result,
        Err(myspace_lib::domain::errors::WorkspaceError::NotFound(_))
    ));

    // The valid note must NOT have been trashed (rollback).
    let snapshot = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert!(snapshot.cards.iter().any(|c| c.id() == "note-ok"));
}

fn note_input(board_id: &str, id: &str, plain_text: &str) -> CreateNoteInput {
    CreateNoteInput {
        id: id.to_string(),
        board_id: board_id.to_string(),
        frame: Frame {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 80.0,
        },
        z_index: 0,
        document_json: serde_json::json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": plain_text}]}]}),
    }
}

/// Turns a note into a Link Card, optionally with an imported favicon asset.
/// Mirrors what enrichment does: a favicon row plus the card pointing at it.
fn link_card(conn: &mut rusqlite::Connection, board_id: &str, id: &str, favicon: bool) {
    workspace_repository::create_note(conn, &note_input(board_id, id, "https://example.com"))
        .unwrap();
    workspace_repository::convert_note_to_embed(
        conn,
        &myspace_lib::domain::models::ConvertNoteToEmbedInput {
            id: id.to_string(),
            expected_revision: 1,
            source_url: "https://example.com/article".to_string(),
            display_url: "example.com".to_string(),
            title: "An article worth keeping".to_string(),
            description_json: serde_json::json!({ "type": "doc" }),
        },
    )
    .unwrap();

    if favicon {
        let asset = if id == "link-favicon" {
            "fav-1"
        } else {
            "fav-x"
        };
        conn.execute(
            "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at)
             VALUES (?1, ?2, 'image/png', 'favicon_32x32.png', 32, 32, 4, 0)",
            rusqlite::params![asset, format!("{asset}.png")],
        )
        .unwrap();
        conn.execute(
            "UPDATE embed_cards SET favicon_asset_id = ?1 WHERE card_id = ?2",
            rusqlite::params![asset, id],
        )
        .unwrap();
    }
}

#[test]
fn list_trash_reports_a_link_card_without_a_favicon() {
    // A Link Card enriched before any favicon was fetched leaves
    // `favicon_asset_id` NULL, and a trashed card is still listed. Reading that
    // column as a required value made the whole drawer fail with
    // "Invalid column type Null at index: 17, name: favicon_asset_id".
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    link_card(&mut conn, &home, "link-plain", false);
    trash_service::trash_note(&mut conn, "link-plain").unwrap();

    let summary = trash_service::list_trash(&conn).unwrap();
    assert_eq!(summary.card_count, 1);
    let item = &summary.batches[0].items[0];
    assert_eq!(item.kind, "embed");
    assert_eq!(item.title, "An article worth keeping");
    assert!(item.thumbnail_asset.is_none());
}

#[test]
fn list_trash_reports_a_link_card_that_has_a_favicon() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    link_card(&mut conn, &home, "link-favicon", true);
    trash_service::trash_note(&mut conn, "link-favicon").unwrap();

    let summary = trash_service::list_trash(&conn).unwrap();
    let item = &summary.batches[0].items[0];
    assert_eq!(item.title, "An article worth keeping");
    let thumbnail = item
        .thumbnail_asset
        .as_ref()
        .expect("the favicon is the thumbnail when there is no preview image");
    assert_eq!(thumbnail.id, "fav-1");
    assert_eq!(thumbnail.file_path, "fav-1.png");
    assert_eq!(thumbnail.width, Some(32));
}

#[test]
fn list_trash_is_empty_initially() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();

    let summary = trash_service::list_trash(&conn).unwrap();
    assert_eq!(summary.batch_count, 0);
    assert!(summary.batches.is_empty());
    assert_eq!(summary.board_count, 0);
    assert_eq!(summary.card_count, 0);
}

#[test]
fn list_trash_reports_a_file_card_by_its_file() {
    // A File Card carries no text of its own, so an empty row is what the drawer
    // shows if the projection forgets it — and its own asset is the document,
    // never a thumbnail to render.
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at)
         VALUES ('file-asset', 'file-asset.md', 'text/markdown', 'meeting-notes.md', NULL, NULL, 2048, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at)
         VALUES ('fc1', ?1, 'file', 0, 0, 320, 240, 0, 1, 0, 0)",
        [&home],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO file_cards (card_id, asset_id, mime_type, preview_text) VALUES ('fc1', 'file-asset', 'text/markdown', 'body')",
        [],
    )
    .unwrap();
    trash_service::trash_note(&mut conn, "fc1").unwrap();

    let summary = trash_service::list_trash(&conn).unwrap();
    let item = &summary.batches[0].items[0];
    assert_eq!(item.kind, "file");
    assert_eq!(item.title, "meeting-notes.md");
    assert!(
        item.thumbnail_asset.is_none(),
        "without a generated thumbnail there is nothing to render"
    );
}

#[test]
fn list_trash_shows_a_file_cards_generated_thumbnail() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    for (id, path, name, mime) in [
        (
            "file-asset",
            "file-asset.pdf",
            "deck.pdf",
            "application/pdf",
        ),
        (
            "file-thumb",
            "file-thumb.png",
            "file-thumb.png",
            "image/png",
        ),
    ] {
        conn.execute(
            "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at)
             VALUES (?1, ?2, ?3, ?4, NULL, NULL, 2048, 0)",
            rusqlite::params![id, path, mime, name],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at)
         VALUES ('fc1', ?1, 'file', 0, 0, 320, 240, 0, 1, 0, 0)",
        [&home],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO file_cards (card_id, asset_id, mime_type, preview_text, preview_asset_id)
         VALUES ('fc1', 'file-asset', 'application/pdf', 'body', 'file-thumb')",
        [],
    )
    .unwrap();
    trash_service::trash_note(&mut conn, "fc1").unwrap();

    let summary = trash_service::list_trash(&conn).unwrap();
    let item = &summary.batches[0].items[0];
    assert_eq!(item.title, "deck.pdf");
    let thumbnail = item
        .thumbnail_asset
        .as_ref()
        .expect("the generated thumbnail");
    assert_eq!(thumbnail.id, "file-thumb");
    assert_eq!(thumbnail.file_path, "file-thumb.png");
}

#[test]
fn list_trash_reports_an_image_card_with_its_asset() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at)
         VALUES ('img-1', 'img-1.png', 'image/png', 'screenshot.png', 640, 480, 1234, 0)",
        [],
    )
    .unwrap();
    workspace_repository::create_image_card(
        &mut conn,
        &myspace_lib::domain::models::CreateImageCardInput {
            id: "ic1".to_string(),
            board_id: home.clone(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 320.0,
                height: 240.0,
            },
            z_index: 0,
            asset_id: "img-1".to_string(),
            caption_json: serde_json::json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Screenshot of dashboard"}]}]}),
        },
    )
    .unwrap();
    trash_service::trash_note(&mut conn, "ic1").unwrap();

    let summary = trash_service::list_trash(&conn).unwrap();
    let item = &summary.batches[0].items[0];
    assert_eq!(item.kind, "image");
    assert_eq!(item.title, "Screenshot of dashboard");
    let thumbnail = item
        .thumbnail_asset
        .as_ref()
        .expect("the image is its own thumbnail");
    assert_eq!(thumbnail.id, "img-1");
    assert_eq!(thumbnail.file_name, "screenshot.png");
    assert_eq!(thumbnail.size_bytes, 1234);
    assert_eq!(thumbnail.file_path, "img-1.png");
}

#[test]
fn list_trash_reports_one_deleted_note() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    workspace_repository::create_note(&mut conn, &note_input(&home, "n1", "Hello world")).unwrap();
    trash_service::trash_note(&mut conn, "n1").unwrap();

    let summary = trash_service::list_trash(&conn).unwrap();
    assert_eq!(summary.batch_count, 1);
    assert_eq!(summary.board_count, 0);
    assert_eq!(summary.card_count, 1);

    let batch = &summary.batches[0];
    assert_eq!(batch.board_count, 0);
    assert_eq!(batch.card_count, 1);
    assert_eq!(batch.items.len(), 1);
    assert_eq!(batch.items[0].id, "n1");
    assert_eq!(batch.items[0].kind, "note");
    assert_eq!(batch.items[0].title, "Hello world");
}

#[test]
fn list_trash_reports_mixed_note_and_board_batch() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    workspace_repository::create_note(&mut conn, &note_input(&home, "n1", "keep me")).unwrap();
    board_service::create_child_board(&mut conn, &child_input(&home, "b1", "p1")).unwrap();

    let batch = trash_service::trash_selection(
        &mut conn,
        &TrashSelectionInput {
            items: vec![
                TrashItem {
                    id: "n1".to_string(),
                    kind: "note".to_string(),
                },
                TrashItem {
                    id: "b1".to_string(),
                    kind: "board_portal".to_string(),
                },
            ],
        },
    )
    .unwrap();

    let summary = trash_service::list_trash(&conn).unwrap();
    assert_eq!(summary.batch_count, 1);
    assert_eq!(summary.board_count, 1);
    // The note card plus the trashed portal card are both in the batch.
    assert_eq!(summary.card_count, 2);

    let entry = &summary.batches[0];
    assert_eq!(entry.batch_id, batch);
    assert_eq!(entry.board_count, 1);
    assert_eq!(entry.card_count, 2);
    assert_eq!(entry.items.len(), 2);

    let board_item = entry.items.iter().find(|i| i.kind == "board").unwrap();
    assert_eq!(board_item.id, "b1");
    assert_eq!(board_item.title, "Child");
    let note_item = entry.items.iter().find(|i| i.kind == "note").unwrap();
    assert_eq!(note_item.id, "n1");
    assert_eq!(note_item.title, "keep me");
}

#[test]
fn list_trash_summarizes_board_subtree_without_duplicate_portal() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    board_service::create_child_board(&mut conn, &child_input(&home, "b1", "p1")).unwrap();
    board_service::create_child_board(&mut conn, &child_input("b1", "b2", "p2")).unwrap();

    trash_service::trash_board(&mut conn, "b1").unwrap();

    let summary = trash_service::list_trash(&conn).unwrap();
    assert_eq!(summary.batch_count, 1);
    assert_eq!(summary.board_count, 2, "b1 and b2 both trashed");
    // The primary portal p1 (on Home, to b1) and p2 (on b1, to b2) are both
    // trashed; neither is listed as an item, only counted.
    assert_eq!(summary.card_count, 2);

    let entry = &summary.batches[0];
    // Only b1 is a top-level representative; b2 and the portals are summarized.
    assert_eq!(entry.items.len(), 1);
    assert_eq!(entry.items[0].id, "b1");
    assert_eq!(entry.items[0].kind, "board");
}
