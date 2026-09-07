//! Workspace search: matches Board titles, Note plain text, and Link Card
//! title/URL/description, with root-first board trails and trashed exclusion.

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::board_service;
use myspace_lib::domain::models::{
    CreateChildBoardInput, CreateLinkBatchInput, CreateNoteInput, Frame, LinkBatchItem,
};
use myspace_lib::domain::trash_service;
use myspace_lib::repositories::workspace_repository;

fn root_board_id(conn: &rusqlite::Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
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
