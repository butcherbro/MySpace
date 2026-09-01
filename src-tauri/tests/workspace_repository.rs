//! Repository tests: load a board snapshot and create notes transactionally.

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::models::{CreateNoteInput, Frame};
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
