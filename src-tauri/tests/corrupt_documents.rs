//! P1.7: a stored rich-text document that is not valid JSON is an explicit
//! `corrupt` state on the card DTO (never a failed board load, never a silent
//! `null`), and writes over it require `acknowledge_corrupt`.

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::errors::WorkspaceError;
use myspace_lib::domain::models::{
    CardDto, ConvertNoteToEmbedInput, CreateImageCardInput, CreateNoteInput, Frame,
    UpdateEmbedDescriptionInput, UpdateImageCaptionInput, UpdateNoteInput,
};
use myspace_lib::repositories::workspace_repository as repo;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

fn setup() -> (Connection, String) {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = conn
        .query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    (conn, home)
}

fn doc(text: &str) -> Value {
    json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]})
}

fn empty_doc() -> Value {
    json!({"type":"doc","content":[]})
}

fn frame(x: f64) -> Frame {
    Frame {
        x,
        y: 0.0,
        width: 200.0,
        height: 80.0,
    }
}

fn create_note(conn: &mut Connection, board: &str, id: &str, text: &str) {
    repo::create_note(
        conn,
        &CreateNoteInput {
            id: id.into(),
            board_id: board.into(),
            frame: frame(0.0),
            z_index: 0,
            document_json: doc(text),
        },
    )
    .unwrap();
}

/// Seeds a healthy note, a note, an image and a link whose stored documents
/// are then corrupted directly in SQLite.
fn seed(conn: &mut Connection, home: &str) {
    create_note(conn, home, "healthy", "fine");
    create_note(conn, home, "bad-note", "recoverable words");
    conn.execute(
        "UPDATE note_cards SET document_json = 'not json' WHERE card_id = 'bad-note'",
        [],
    )
    .unwrap();

    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at)
         VALUES ('a1', 'a1.png', 'image/png', 'a1.png', 64, 32, 10, 0)",
        [],
    )
    .unwrap();
    repo::create_image_card(
        conn,
        &CreateImageCardInput {
            id: "bad-image".into(),
            board_id: home.into(),
            frame: frame(10.0),
            z_index: 1,
            asset_id: "a1".into(),
            caption_json: doc("caption words"),
        },
    )
    .unwrap();
    conn.execute(
        "UPDATE image_cards SET caption_json = '{\"type\":' WHERE card_id = 'bad-image'",
        [],
    )
    .unwrap();

    create_note(conn, home, "bad-link", "x");
    repo::convert_note_to_embed(
        conn,
        &ConvertNoteToEmbedInput {
            id: "bad-link".into(),
            expected_revision: 1,
            source_url: "https://example.com".into(),
            display_url: "example.com".into(),
            title: "Example".into(),
            description_json: doc("description words"),
        },
    )
    .unwrap();
    conn.execute(
        "UPDATE embed_cards SET description_json = '<<garbage>>' WHERE card_id = ?1",
        params!["bad-link"],
    )
    .unwrap();
}

fn find<'a>(cards: &'a [CardDto], id: &str) -> &'a CardDto {
    cards.iter().find(|c| c.id() == id).expect(id)
}

#[test]
fn corrupt_documents_load_as_explicit_state_without_failing_the_board() {
    let (mut conn, home) = setup();
    seed(&mut conn, &home);

    let snapshot = repo::load_board_snapshot(&conn, &home).expect("board still loads");
    assert_eq!(snapshot.cards.len(), 4, "every card is present");

    let CardDto::Note(healthy) = find(&snapshot.cards, "healthy") else {
        panic!("note");
    };
    assert!(!healthy.corrupt);
    assert_eq!(healthy.document_json, doc("fine"));

    let CardDto::Note(note) = find(&snapshot.cards, "bad-note") else {
        panic!("note");
    };
    assert!(note.corrupt);
    assert_eq!(note.document_json, empty_doc());
    assert_eq!(note.plain_text, "recoverable words");

    let CardDto::Image(image) = find(&snapshot.cards, "bad-image") else {
        panic!("image");
    };
    assert!(image.corrupt);
    assert_eq!(image.caption_json, empty_doc());
    assert_eq!(image.caption_plain_text, "caption words");

    let CardDto::Embed(link) = find(&snapshot.cards, "bad-link") else {
        panic!("embed");
    };
    assert!(link.corrupt);
    assert_eq!(link.description_json, empty_doc());
    assert_eq!(link.description_plain_text, "description words");

    // Single-card paths agree.
    let CardDto::Note(one) = repo::load_card(&conn, "bad-note").unwrap() else {
        panic!("note");
    };
    assert!(one.corrupt);
    assert!(repo::load_embed_card(&conn, "bad-link").unwrap().corrupt);

    // Serialized as camelCase `corrupt`.
    let wire = serde_json::to_value(&snapshot.cards).unwrap();
    let wire_note = wire
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "bad-note")
        .unwrap();
    assert_eq!(wire_note["corrupt"], true);
}

#[test]
fn blank_description_is_no_document_not_corrupt() {
    let (mut conn, home) = setup();
    seed(&mut conn, &home);
    conn.execute(
        "UPDATE embed_cards SET description_json = '' WHERE card_id = 'bad-link'",
        [],
    )
    .unwrap();
    let link = repo::load_embed_card(&conn, "bad-link").unwrap();
    assert!(!link.corrupt);
    assert_eq!(link.description_json, Value::Null);
}

fn is_corrupt_rejection(result: Result<impl std::fmt::Debug, WorkspaceError>) -> bool {
    matches!(result, Err(WorkspaceError::ConstraintViolation(ref m)) if m == "document is corrupt; open it to repair first")
}

#[test]
fn writes_over_a_corrupt_document_require_acknowledgement() {
    let (mut conn, home) = setup();
    seed(&mut conn, &home);

    let note = |ack: bool| UpdateNoteInput {
        id: "bad-note".into(),
        expected_revision: 1,
        document_json: doc("repaired"),
        acknowledge_corrupt: ack,
    };
    assert!(is_corrupt_rejection(repo::update_note(
        &mut conn,
        &note(false)
    )));
    let stored: String = conn
        .query_row(
            "SELECT document_json FROM note_cards WHERE card_id = 'bad-note'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stored, "not json", "the rejected write changed nothing");
    let receipt = repo::update_note(&mut conn, &note(true)).unwrap();
    assert_eq!(receipt.revision, 2);
    let CardDto::Note(repaired) = repo::load_card(&conn, "bad-note").unwrap() else {
        panic!("note");
    };
    assert!(!repaired.corrupt);
    assert_eq!(repaired.document_json, doc("repaired"));

    let caption = |ack: bool| UpdateImageCaptionInput {
        id: "bad-image".into(),
        expected_revision: 1,
        caption_json: doc("new caption"),
        acknowledge_corrupt: ack,
    };
    assert!(is_corrupt_rejection(repo::update_image_caption(
        &mut conn,
        &caption(false)
    )));
    repo::update_image_caption(&mut conn, &caption(true)).unwrap();

    let description = |ack: bool| UpdateEmbedDescriptionInput {
        id: "bad-link".into(),
        expected_revision: 2,
        description_json: doc("new description"),
        acknowledge_corrupt: ack,
    };
    assert!(is_corrupt_rejection(repo::update_embed_description(
        &mut conn,
        &description(false)
    )));
    repo::update_embed_description(&mut conn, &description(true)).unwrap();
    assert!(!repo::load_embed_card(&conn, "bad-link").unwrap().corrupt);

    // Healthy documents need no acknowledgement.
    repo::update_note(
        &mut conn,
        &UpdateNoteInput {
            id: "healthy".into(),
            expected_revision: 1,
            document_json: doc("still fine"),
            acknowledge_corrupt: false,
        },
    )
    .unwrap();
}

#[test]
fn acknowledge_corrupt_defaults_to_false_on_the_wire() {
    let input: UpdateNoteInput = serde_json::from_value(json!({
        "id": "n", "expectedRevision": 1, "documentJson": {"type":"doc"}
    }))
    .unwrap();
    assert!(!input.acknowledge_corrupt);
    let input: UpdateNoteInput = serde_json::from_value(json!({
        "id": "n", "expectedRevision": 1, "documentJson": {"type":"doc"}, "acknowledgeCorrupt": true
    }))
    .unwrap();
    assert!(input.acknowledge_corrupt);
}
