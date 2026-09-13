//! Board move tests: `move_board` must atomically reparent a Board and its
//! unique portal card, with Home/self/descendant/stale guards.

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::board_service;
use myspace_lib::domain::models::{CreateChildBoardInput, Frame, MoveBoardInput};

fn root_board_id(conn: &rusqlite::Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
}

fn mk(parent: &str, id: &str, portal: &str, title: &str) -> CreateChildBoardInput {
    CreateChildBoardInput {
        parent_board_id: parent.to_string(),
        board_id: id.to_string(),
        portal_card_id: portal.to_string(),
        frame: Frame {
            x: 0.0,
            y: 0.0,
            width: 120.0,
            height: 112.0,
        },
        title: title.to_string(),
    }
}

fn parent_of(conn: &rusqlite::Connection, board_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT parent_board_id FROM boards WHERE id = ?1",
        [board_id],
        |r| r.get(0),
    )
    .unwrap()
}

fn portal_board_id(conn: &rusqlite::Connection, board_id: &str) -> String {
    conn.query_row(
        "SELECT c.board_id FROM board_portal_cards p JOIN cards c ON c.id = p.card_id WHERE p.target_board_id = ?1",
        [board_id],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn move_board_reparents_a_child_into_a_sibling() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    // Home -> A, Home -> B ; move A under B.
    board_service::create_child_board(&mut conn, &mk(&home, "a", "pa", "A")).unwrap();
    board_service::create_child_board(&mut conn, &mk(&home, "b", "pb", "B")).unwrap();

    board_service::move_board(
        &mut conn,
        &MoveBoardInput {
            board_id: "a".to_string(),
            expected_board_revision: 1,
            expected_portal_revision: 1,
            target_parent_board_id: "b".to_string(),
            frame: Frame {
                x: 40.0,
                y: 40.0,
                width: 120.0,
                height: 112.0,
            },
        },
    )
    .unwrap();

    assert_eq!(parent_of(&conn, "a").as_deref(), Some("b"));
    // The portal now lives inside board B at the destination frame.
    assert_eq!(portal_board_id(&conn, "a"), "b");
}

fn portal_xy(conn: &rusqlite::Connection, board_id: &str) -> (f64, f64) {
    conn.query_row(
        "SELECT c.x, c.y FROM board_portal_cards p JOIN cards c ON c.id = p.card_id
         WHERE p.target_board_id = ?1 AND c.deleted_at IS NULL",
        [board_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .unwrap()
}

#[test]
fn move_board_places_the_portal_at_the_requested_frame() {
    // The caller - and the undo path in particular - supplies the destination
    // frame. Honouring it is what lets undo put the portal back where it was;
    // silently deriving a fresh free slot relocates it on every move.
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    board_service::create_child_board(&mut conn, &mk(&home, "a", "pa", "A")).unwrap();
    board_service::create_child_board(&mut conn, &mk(&home, "b", "pb", "B")).unwrap();

    board_service::move_board(
        &mut conn,
        &MoveBoardInput {
            board_id: "a".to_string(),
            expected_board_revision: 1,
            expected_portal_revision: 1,
            target_parent_board_id: "b".to_string(),
            frame: Frame {
                x: 333.0,
                y: 222.0,
                width: 120.0,
                height: 112.0,
            },
        },
    )
    .unwrap();

    assert_eq!(portal_xy(&conn, "a"), (333.0, 222.0));
}

#[test]
fn move_board_lifts_a_deep_board_back_to_home() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    // Home -> A -> B ; lift B to Home.
    board_service::create_child_board(&mut conn, &mk(&home, "a", "pa", "A")).unwrap();
    board_service::create_child_board(&mut conn, &mk("a", "b", "pb", "B")).unwrap();

    board_service::move_board(
        &mut conn,
        &MoveBoardInput {
            board_id: "b".to_string(),
            expected_board_revision: 1,
            expected_portal_revision: 1,
            target_parent_board_id: home.clone(),
            frame: Frame {
                x: 40.0,
                y: 40.0,
                width: 120.0,
                height: 112.0,
            },
        },
    )
    .unwrap();

    assert_eq!(parent_of(&conn, "b").as_deref(), Some(home.as_str()));
    assert_eq!(portal_board_id(&conn, "b"), home);
}

#[test]
fn move_board_preserves_descendant_subtree() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    // Home -> A -> B -> C ; move A under home's sibling D: subtree B,C must follow.
    board_service::create_child_board(&mut conn, &mk(&home, "a", "pa", "A")).unwrap();
    board_service::create_child_board(&mut conn, &mk("a", "b", "pb", "B")).unwrap();
    board_service::create_child_board(&mut conn, &mk("b", "c", "pc", "C")).unwrap();
    board_service::create_child_board(&mut conn, &mk(&home, "d", "pd", "D")).unwrap();

    board_service::move_board(
        &mut conn,
        &MoveBoardInput {
            board_id: "a".to_string(),
            expected_board_revision: 1,
            expected_portal_revision: 1,
            target_parent_board_id: "d".to_string(),
            frame: Frame {
                x: 40.0,
                y: 40.0,
                width: 120.0,
                height: 112.0,
            },
        },
    )
    .unwrap();

    // A moved under D; B and C remain children of A (subtree preserved).
    assert_eq!(parent_of(&conn, "a").as_deref(), Some("d"));
    assert_eq!(parent_of(&conn, "b").as_deref(), Some("a"));
    assert_eq!(parent_of(&conn, "c").as_deref(), Some("b"));
}

#[test]
fn move_board_rejects_home() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    let err = board_service::move_board(
        &mut conn,
        &MoveBoardInput {
            board_id: home.clone(),
            expected_board_revision: 1,
            expected_portal_revision: 1,
            target_parent_board_id: "anywhere".to_string(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 120.0,
                height: 112.0,
            },
        },
    )
    .unwrap_err();

    assert!(matches!(
        err,
        myspace_lib::domain::errors::WorkspaceError::RootBoardProtected
    ));
}

#[test]
fn move_board_rejects_self_parent() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    board_service::create_child_board(&mut conn, &mk(&home, "a", "pa", "A")).unwrap();

    let err = board_service::move_board(
        &mut conn,
        &MoveBoardInput {
            board_id: "a".to_string(),
            expected_board_revision: 1,
            expected_portal_revision: 1,
            target_parent_board_id: "a".to_string(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 120.0,
                height: 112.0,
            },
        },
    )
    .unwrap_err();

    assert!(matches!(
        err,
        myspace_lib::domain::errors::WorkspaceError::ConstraintViolation(_)
    ));
}

#[test]
fn move_board_rejects_descendant_cycle() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    // Home -> A -> B ; try to move A under its descendant B (cycle).
    board_service::create_child_board(&mut conn, &mk(&home, "a", "pa", "A")).unwrap();
    board_service::create_child_board(&mut conn, &mk("a", "b", "pb", "B")).unwrap();

    let err = board_service::move_board(
        &mut conn,
        &MoveBoardInput {
            board_id: "a".to_string(),
            expected_board_revision: 1,
            expected_portal_revision: 1,
            target_parent_board_id: "b".to_string(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 120.0,
                height: 112.0,
            },
        },
    )
    .unwrap_err();

    assert!(matches!(
        err,
        myspace_lib::domain::errors::WorkspaceError::ConstraintViolation(_)
    ));
    // Nothing changed.
    assert_eq!(parent_of(&conn, "a").as_deref(), Some(home.as_str()));
}

#[test]
fn move_board_rejects_stale_board_revision() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    board_service::create_child_board(&mut conn, &mk(&home, "a", "pa", "A")).unwrap();
    board_service::create_child_board(&mut conn, &mk(&home, "b", "pb", "B")).unwrap();

    let err = board_service::move_board(
        &mut conn,
        &MoveBoardInput {
            board_id: "a".to_string(),
            expected_board_revision: 99,
            expected_portal_revision: 1,
            target_parent_board_id: "b".to_string(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 120.0,
                height: 112.0,
            },
        },
    )
    .unwrap_err();

    assert!(matches!(
        err,
        myspace_lib::domain::errors::WorkspaceError::StaleRevision { expected: 99, .. }
    ));
}

#[test]
fn move_board_rejects_stale_portal_revision() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    board_service::create_child_board(&mut conn, &mk(&home, "a", "pa", "A")).unwrap();
    board_service::create_child_board(&mut conn, &mk(&home, "b", "pb", "B")).unwrap();

    let err = board_service::move_board(
        &mut conn,
        &MoveBoardInput {
            board_id: "a".to_string(),
            expected_board_revision: 1,
            expected_portal_revision: 99,
            target_parent_board_id: "b".to_string(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 120.0,
                height: 112.0,
            },
        },
    )
    .unwrap_err();

    assert!(matches!(
        err,
        myspace_lib::domain::errors::WorkspaceError::StaleRevision { expected: 99, .. }
    ));
}

#[test]
fn set_and_remove_board_cover() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    board_service::create_child_board(&mut conn, &mk(&home, "a", "pa", "A")).unwrap();

    // Insert a managed asset to reference as the cover.
    let asset_id = "01a0cover-0000-0000-0000-000000000001";
    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, size_bytes, created_at)
         VALUES (?1, 'cover.png', 'image/png', 'cover.png', 0, 0)",
        [asset_id],
    )
    .unwrap();

    // Set the cover.
    board_service::set_board_cover(&mut conn, "a", Some(asset_id)).unwrap();
    let cover: Option<String> = conn
        .query_row(
            "SELECT cover_asset_id FROM boards WHERE id = 'a'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(cover.as_deref(), Some(asset_id));

    // Remove the cover -> back to NULL.
    board_service::set_board_cover(&mut conn, "a", None).unwrap();
    let cover: Option<String> = conn
        .query_row(
            "SELECT cover_asset_id FROM boards WHERE id = 'a'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(cover, None);
}

#[test]
fn set_board_cover_rejects_missing_asset() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    board_service::create_child_board(&mut conn, &mk(&home, "a", "pa", "A")).unwrap();

    let err = board_service::set_board_cover(&mut conn, "a", Some("no-such-asset"));
    assert!(matches!(
        err,
        Err(myspace_lib::domain::errors::WorkspaceError::NotFound(_))
    ));
}
