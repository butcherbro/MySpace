//! Note background color backend contract: semantic preset persistence, the
//! `default` fallback, and the guarantee that color changes never touch the
//! card's document or revision.

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::models::{CardDto, CreateNoteInput, Frame, SetNoteColorInput};
use myspace_lib::repositories::workspace_repository;

fn root_board_id(conn: &rusqlite::Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
}

fn note_input(board_id: &str, id: &str) -> CreateNoteInput {
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
        document_json: serde_json::json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "hello"}]}]}),
    }
}

fn note_in_snapshot<'a>(
    snapshot: &'a myspace_lib::domain::models::BoardSnapshot,
    id: &str,
) -> &'a myspace_lib::domain::models::NoteCardDto {
    snapshot
        .cards
        .iter()
        .find_map(|c| match c {
            CardDto::Note(n) if n.id == id => Some(n),
            _ => None,
        })
        .unwrap()
}

#[test]
fn new_notes_default_to_the_default_color() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    workspace_repository::create_note(&mut conn, &note_input(&home, "n1")).unwrap();

    let snapshot = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert_eq!(note_in_snapshot(&snapshot, "n1").color_token, "default");
}

#[test]
fn set_note_color_persists_without_touching_document_or_revision() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    workspace_repository::create_note(&mut conn, &note_input(&home, "n1")).unwrap();
    let before = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    let before_note = note_in_snapshot(&before, "n1");

    workspace_repository::set_note_color(
        &mut conn,
        &SetNoteColorInput {
            id: "n1".to_string(),
            color_token: "yellow".to_string(),
        },
    )
    .unwrap();

    let after = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    let after_note = note_in_snapshot(&after, "n1");

    assert_eq!(after_note.color_token, "yellow");
    // Color is orthogonal to content: document and revision are unchanged.
    assert_eq!(after_note.document_json, before_note.document_json);
    assert_eq!(after_note.revision, before_note.revision);
}

#[test]
fn set_note_color_rejects_unknown_note() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();

    let result = workspace_repository::set_note_color(
        &mut conn,
        &SetNoteColorInput {
            id: "missing".to_string(),
            color_token: "blue".to_string(),
        },
    );
    assert!(result.is_err());
}

#[test]
fn set_note_color_does_not_affect_other_cards_or_boards() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    workspace_repository::create_note(&mut conn, &note_input(&home, "n1")).unwrap();
    workspace_repository::create_note(&mut conn, &note_input(&home, "n2")).unwrap();

    workspace_repository::set_note_color(
        &mut conn,
        &SetNoteColorInput {
            id: "n1".to_string(),
            color_token: "green".to_string(),
        },
    )
    .unwrap();

    let snapshot = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert_eq!(note_in_snapshot(&snapshot, "n1").color_token, "green");
    assert_eq!(note_in_snapshot(&snapshot, "n2").color_token, "default");
}
