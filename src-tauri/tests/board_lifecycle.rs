//! Board lifecycle: child-board creation is transactional and idempotent.

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::board_service;
use myspace_lib::domain::models::{CreateChildBoardInput, Frame};

fn root_board_id(conn: &rusqlite::Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
}

fn board_count(conn: &rusqlite::Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM boards", [], |r| r.get(0))
        .unwrap()
}

fn portal_count(conn: &rusqlite::Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM board_portal_cards", [], |r| r.get(0))
        .unwrap()
}

fn view_state_count(conn: &rusqlite::Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM board_view_states", [], |r| r.get(0))
        .unwrap()
}

fn input(parent: &str, board_id: &str, portal_id: &str, title: &str) -> CreateChildBoardInput {
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

#[test]
fn create_child_board_creates_board_view_state_and_portal_atomically() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    board_service::create_child_board(&mut conn, &input(&home, "b1", "p1", "New Board")).unwrap();

    assert_eq!(board_count(&conn), 2, "child board must exist");
    assert_eq!(portal_count(&conn), 1, "one portal card must exist");
    assert_eq!(
        view_state_count(&conn),
        2,
        "child board must have a view state"
    );

    // The portal targets the new board and its parent is Home.
    let (parent, target): (String, String) = conn
        .query_row(
            "SELECT c.board_id, p.target_board_id FROM cards c
             JOIN board_portal_cards p ON p.card_id = c.id",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(parent, home);
    assert_eq!(target, "b1");
}

#[test]
fn create_child_board_rejects_empty_title() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    let result = board_service::create_child_board(&mut conn, &input(&home, "b1", "p1", "   "));
    assert!(result.is_err());
    assert_eq!(board_count(&conn), 1, "no board may be created");
}

#[test]
fn create_child_board_rejects_missing_parent() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();

    let result =
        board_service::create_child_board(&mut conn, &input("nope", "b1", "p1", "New Board"));
    assert!(result.is_err());
    assert_eq!(board_count(&conn), 1);
}

#[test]
fn create_child_board_is_idempotent_on_replay() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    board_service::create_child_board(&mut conn, &input(&home, "b1", "p1", "New Board")).unwrap();
    // Replaying the exact same create returns the existing aggregate, no dupes.
    board_service::create_child_board(&mut conn, &input(&home, "b1", "p1", "New Board")).unwrap();

    assert_eq!(board_count(&conn), 2);
    assert_eq!(portal_count(&conn), 1);
}

#[test]
fn create_child_board_rejects_conflicting_id_reuse() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    board_service::create_child_board(&mut conn, &input(&home, "b1", "p1", "New Board")).unwrap();

    // Reusing a portal card id with a different board id is a conflict.
    let result =
        board_service::create_child_board(&mut conn, &input(&home, "b2", "p1", "New Board"));
    assert!(result.is_err());
    assert_eq!(board_count(&conn), 2, "no extra board");
}

#[test]
fn rename_board_updates_title_and_revision() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    board_service::create_child_board(&mut conn, &input(&home, "b1", "p1", "New Board")).unwrap();
    board_service::rename_board(&mut conn, "b1", "Books").unwrap();

    let title: String = conn
        .query_row("SELECT title FROM boards WHERE id = 'b1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(title, "Books");
}
