//! Irreversible Trash emptying: hard-delete of trashed relational rows plus a
//! confirmation gate. Asset GC is covered separately.

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::board_service;
use myspace_lib::domain::models::{
    AddQuickBoardInput, CreateChildBoardInput, CreateNoteInput, Frame,
};
use myspace_lib::domain::trash_service;
use myspace_lib::repositories::workspace_repository;

fn root_board_id(conn: &rusqlite::Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
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
        document_json: serde_json::json!({ "type": "doc" }),
        plain_text: "".to_string(),
    }
}

fn count(conn: &rusqlite::Connection, q: &str) -> i64 {
    conn.query_row(q, [], |r| r.get(0)).unwrap()
}

#[test]
fn empty_trash_rejects_wrong_confirmation() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    workspace_repository::create_note(&mut conn, &note_input(&home, "n1")).unwrap();
    trash_service::trash_note(&mut conn, "n1").unwrap();

    let result = trash_service::empty_trash(&mut conn, "not-empty");
    assert!(result.is_err());
    // Nothing was deleted.
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM cards"), 1);
}

#[test]
fn empty_trash_hard_deletes_a_trashed_note() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    workspace_repository::create_note(&mut conn, &note_input(&home, "n1")).unwrap();
    trash_service::trash_note(&mut conn, "n1").unwrap();

    let result = trash_service::empty_trash(&mut conn, "EMPTY").unwrap();
    assert_eq!(result.card_count, 1);
    assert_eq!(result.board_count, 0);

    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM cards WHERE id = 'n1'"),
        0
    );
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM note_cards WHERE card_id = 'n1'"
        ),
        0
    );
}

#[test]
fn empty_trash_hard_deletes_a_board_subtree_and_quick_board_refs() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    board_service::create_child_board(&mut conn, &child_input(&home, "b1", "p1")).unwrap();
    board_service::create_child_board(&mut conn, &child_input("b1", "b2", "p2")).unwrap();
    workspace_repository::add_quick_board(
        &mut conn,
        &AddQuickBoardInput {
            board_id: "b1".to_string(),
        },
    )
    .unwrap();

    trash_service::trash_board(&mut conn, "b1").unwrap();

    let result = trash_service::empty_trash(&mut conn, "EMPTY").unwrap();
    assert_eq!(result.board_count, 2, "b1 and b2 trashed and deleted");
    assert!(result.card_count >= 1, "portal(s) deleted");

    // Only the root remains active.
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM boards"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM cards"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM board_view_states"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM quick_boards"), 0);
}

#[test]
fn empty_trash_keeps_active_rows_untouched() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    workspace_repository::create_note(&mut conn, &note_input(&home, "active")).unwrap();
    workspace_repository::create_note(&mut conn, &note_input(&home, "trashed")).unwrap();
    trash_service::trash_note(&mut conn, "trashed").unwrap();

    trash_service::empty_trash(&mut conn, "EMPTY").unwrap();

    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM cards WHERE id = 'active'"),
        1
    );
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM cards WHERE id = 'trashed'"),
        0
    );
}
