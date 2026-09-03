//! Trash lifecycle: recursive subtree soft-delete and batch restore.

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::board_service;
use myspace_lib::domain::models::{CreateChildBoardInput, Frame};
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
