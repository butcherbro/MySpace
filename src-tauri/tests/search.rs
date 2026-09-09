//! Workspace search: matches Board titles, Note plain text, and Link Card
//! title/URL/description, with root-first board trails and trashed exclusion.

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::board_service;
use myspace_lib::domain::models::{
    CreateChildBoardInput, CreateFilesystemAliasInput, CreateImageCardInput, CreateLinkBatchInput, CreateNoteInput, Frame,
    LinkBatchItem,
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
fn search_matches_folder_alias_display_name_and_path_hint() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    workspace_repository::create_filesystem_alias(&mut conn, &CreateFilesystemAliasInput {
        id: "folder-1".into(),
        board_id: home.clone(),
        frame: Frame { x: 0.0, y: 0.0, width: 360.0, height: 300.0 },
        z_index: 0,
        target_kind: "folder".into(),
        locator_blob: vec![1, 2, 3],
        path_hint: "/Volumes/Studio/Video project".into(),
        display_name: "Video project".into(),
    }).unwrap();

    let by_name = workspace_repository::search_workspace(&conn, "VIDEO PROJECT").unwrap();
    assert_eq!(by_name.len(), 1);
    assert_eq!(by_name[0].kind, "folder");
    assert_eq!(by_name[0].entity_id, "folder-1");
    assert_eq!(by_name[0].title, "Video project");
    assert_eq!(by_name[0].excerpt, None);

    let by_path = workspace_repository::search_workspace(&conn, "studio").unwrap();
    assert_eq!(by_path.len(), 1);
    assert_eq!(by_path[0].entity_id, "folder-1");
    assert_eq!(by_path[0].excerpt.as_deref(), Some("/Volumes/Studio/Video project"));
}

fn child_input(
    parent: &str,
    board_id: &str,
    portal_id: &str,
    title: &str,
) -> CreateChildBoardInput {
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
        title: title.to_string(),
    }
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
        document_json: serde_json::json!({ "type": "doc" }),
        plain_text: plain_text.to_string(),
    }
}

fn link_input(
    board_id: &str,
    id: &str,
    title: &str,
    url: &str,
    description: &str,
) -> CreateLinkBatchInput {
    CreateLinkBatchInput {
        idempotency_key: format!("key-{id}"),
        board_id: board_id.to_string(),
        links: vec![LinkBatchItem {
            id: id.to_string(),
            source_url: url.to_string(),
            title: title.to_string(),
            description: description.to_string(),
        }],
    }
}

#[test]
fn search_empty_query_returns_nothing() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    workspace_repository::create_note(&mut conn, &note_input(&home, "n1", "hello")).unwrap();

    let results = workspace_repository::search_workspace(&conn, "   ").unwrap();
    assert!(results.is_empty());
}

#[test]
fn search_matches_board_title_case_insensitively() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    board_service::create_child_board(&mut conn, &child_input(&home, "b1", "p1", "Research"))
        .unwrap();

    let results = workspace_repository::search_workspace(&conn, "RESEARCH").unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].kind, "board");
    assert_eq!(results[0].entity_id, "b1");
    assert_eq!(results[0].title, "Research");
    assert_eq!(results[0].excerpt, None);
}

#[test]
fn search_matches_note_plain_text_case_insensitively() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    workspace_repository::create_note(
        &mut conn,
        &note_input(&home, "n1", "Remember to ship the rocket"),
    )
    .unwrap();

    let results = workspace_repository::search_workspace(&conn, "ROCKET").unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].kind, "note");
    assert_eq!(results[0].entity_id, "n1");
    assert_eq!(results[0].board_id, home);
    assert_eq!(results[0].title, "Remember to ship the rocket");
}

#[test]
fn search_matches_link_title_url_and_description() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    workspace_repository::create_link_batch(
        &mut conn,
        &link_input(
            &home,
            "l1",
            "Example Domain",
            "https://example.com",
            "A useful example",
        ),
    )
    .unwrap();

    // By title.
    let by_title = workspace_repository::search_workspace(&conn, "Domain").unwrap();
    assert_eq!(by_title.len(), 1);
    assert_eq!(by_title[0].kind, "link");
    assert_eq!(by_title[0].entity_id, "l1");
    assert_eq!(by_title[0].title, "Example Domain");
    assert_eq!(by_title[0].excerpt, None, "title match has no excerpt");

    // By URL.
    let by_url = workspace_repository::search_workspace(&conn, "example.com").unwrap();
    assert_eq!(by_url.len(), 1);
    assert_eq!(by_url[0].entity_id, "l1");

    // By description.
    let by_desc = workspace_repository::search_workspace(&conn, "useful").unwrap();
    assert_eq!(by_desc.len(), 1);
    assert_eq!(by_desc[0].entity_id, "l1");
    assert_eq!(by_desc[0].excerpt.as_deref(), Some("A useful example"));
}

#[test]
fn search_excludes_trashed_entities() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    workspace_repository::create_note(&mut conn, &note_input(&home, "n1", "tobedeleted")).unwrap();
    trash_service::trash_note(&mut conn, "n1").unwrap();

    let results = workspace_repository::search_workspace(&conn, "tobedeleted").unwrap();
    assert!(results.is_empty());
}

#[test]
fn search_returns_root_first_board_trail_for_nested_note() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    board_service::create_child_board(&mut conn, &child_input(&home, "b1", "p1", "Research"))
        .unwrap();
    workspace_repository::create_note(&mut conn, &note_input("b1", "n1", "deep note")).unwrap();

    let results = workspace_repository::search_workspace(&conn, "deep note").unwrap();
    assert_eq!(results.len(), 1);
    let trail = results[0]
        .board_trail
        .iter()
        .map(|c| c.title.as_str())
        .collect::<Vec<_>>();
    assert_eq!(trail, vec!["Home", "Research"]);
}

#[test]
fn search_orders_title_matches_before_body_matches() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    // A note whose body contains the term, and a board whose title contains it.
    workspace_repository::create_note(&mut conn, &note_input(&home, "n1", "word in a note"))
        .unwrap();
    board_service::create_child_board(&mut conn, &child_input(&home, "b1", "p1", "word")).unwrap();

    let results = workspace_repository::search_workspace(&conn, "word").unwrap();
    assert_eq!(results.len(), 2);
    // The board (title match) sorts before the note (body match).
    assert_eq!(results[0].kind, "board");
    assert_eq!(results[1].kind, "note");
}

#[test]
fn search_matches_image_caption_and_filename() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    // Insert a minimal asset row + a card referencing it with a caption.
    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at)
         VALUES ('img-1', 'img-1.png', 'image/png', 'screenshot-final.png', NULL, NULL, 0, 0)",
        [],
    )
    .unwrap();
    workspace_repository::create_image_card(
        &mut conn,
        &CreateImageCardInput {
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
            caption_json: serde_json::json!({ "type": "doc" }),
            caption_plain_text: "Screenshot of dashboard".to_string(),
        },
    )
    .unwrap();

    // By caption.
    let by_caption = workspace_repository::search_workspace(&conn, "dashboard").unwrap();
    assert_eq!(by_caption.len(), 1);
    assert_eq!(by_caption[0].kind, "image");
    assert_eq!(by_caption[0].title, "Screenshot of dashboard");

    // By file name.
    let by_file = workspace_repository::search_workspace(&conn, "screenshot-final").unwrap();
    assert_eq!(by_file.len(), 1);
    assert_eq!(by_file[0].kind, "image");
}

#[test]
fn search_matches_cyrillic_case_insensitively() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    workspace_repository::create_note(&mut conn, &note_input(&home, "n1", "Путь мыслителя"))
        .unwrap();
    workspace_repository::create_note(&mut conn, &note_input(&home, "n2", "простой текст"))
        .unwrap();

    // Lowercase query matches uppercase Cyrillic text.
    let results = workspace_repository::search_workspace(&conn, "путь").unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].kind, "note");
    assert_eq!(results[0].title, "Путь мыслителя");
}
