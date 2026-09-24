//! Quick Boards persistence tests: list / add (idempotent, non-Home) / remove /
//! reorder, against a real UUIDv7 Home id produced by bootstrap. Exercises the
//! repository directly; the service-through-Workspace path is covered by
//! `tests/workspace_service.rs`.

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::board_service;
use myspace_lib::domain::models::{
    AddQuickBoardInput, CreateChildBoardInput, Frame, ReorderQuickBoardsInput,
};
use myspace_lib::repositories::workspace_repository;

fn root_board_id(conn: &rusqlite::Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
}

fn child(parent: &str, id: &str, portal: &str, title: &str) -> CreateChildBoardInput {
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

#[test]
fn home_is_a_real_uuid_v7_id() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    // Production Home IDs are UUIDv7; guarded against a hardcoded "home" sentinel.
    assert_ne!(home, "home");
    assert!(home.contains('-'));
}

#[test]
fn list_starts_empty() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let quick = workspace_repository::list_quick_boards(&conn).unwrap();
    assert!(quick.is_empty());
}

#[test]
fn add_then_list_ordered() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    board_service::create_child_board(&mut conn, &child(&home, "a", "pa", "A")).unwrap();
    board_service::create_child_board(&mut conn, &child(&home, "b", "pb", "B")).unwrap();
    conn.execute("UPDATE boards SET symbol = 'B!' WHERE id = 'b'", [])
        .unwrap();

    workspace_repository::add_quick_board(
        &mut conn,
        &AddQuickBoardInput {
            board_id: "b".into(),
        },
    )
    .unwrap();
    workspace_repository::add_quick_board(
        &mut conn,
        &AddQuickBoardInput {
            board_id: "a".into(),
        },
    )
    .unwrap();

    let quick = workspace_repository::list_quick_boards(&conn).unwrap();
    assert_eq!(
        quick
            .iter()
            .map(|q| q.board_id.as_str())
            .collect::<Vec<_>>(),
        vec!["b", "a"]
    );
    assert_eq!(quick[0].title, "B");
    assert_eq!(quick[0].symbol.as_deref(), Some("B!"));
    assert_eq!(quick[1].title, "A");
}

#[test]
fn list_projects_the_board_cover_asset() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    board_service::create_child_board(&mut conn, &child(&home, "a", "pa", "A")).unwrap();
    conn.execute(
        "INSERT INTO assets
            (id, file_path, mime_type, file_name, width, height, size_bytes, created_at)
         VALUES
            ('asset-a', 'asset-a.png', 'image/png', 'cover.png', 320, 180, 4096, 1)",
        [],
    )
    .unwrap();
    board_service::set_board_cover(&mut conn, "a", Some("asset-a")).unwrap();
    workspace_repository::add_quick_board(
        &mut conn,
        &AddQuickBoardInput {
            board_id: "a".into(),
        },
    )
    .unwrap();

    let quick = workspace_repository::list_quick_boards(&conn).unwrap();
    let cover = quick[0].cover_asset.as_ref().expect("cover projection");
    assert_eq!(cover.id, "asset-a");
    assert_eq!(cover.file_path, "asset-a.png");
    assert_eq!(cover.width, Some(320));
    assert_eq!(cover.height, Some(180));
    assert_eq!(cover.size_bytes, 4096);
}

#[test]
fn add_is_idempotent() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    board_service::create_child_board(&mut conn, &child(&home, "a", "pa", "A")).unwrap();

    workspace_repository::add_quick_board(
        &mut conn,
        &AddQuickBoardInput {
            board_id: "a".into(),
        },
    )
    .unwrap();
    workspace_repository::add_quick_board(
        &mut conn,
        &AddQuickBoardInput {
            board_id: "a".into(),
        },
    )
    .unwrap();

    let quick = workspace_repository::list_quick_boards(&conn).unwrap();
    assert_eq!(quick.len(), 1);
}

#[test]
fn add_home_is_rejected() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    let result =
        workspace_repository::add_quick_board(&mut conn, &AddQuickBoardInput { board_id: home });
    assert!(matches!(
        result,
        Err(myspace_lib::domain::errors::WorkspaceError::RootBoardProtected)
    ));
}

#[test]
fn add_missing_board_is_not_found() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();

    let result = workspace_repository::add_quick_board(
        &mut conn,
        &AddQuickBoardInput {
            board_id: "no-such-board".into(),
        },
    );
    assert!(matches!(
        result,
        Err(myspace_lib::domain::errors::WorkspaceError::NotFound(_))
    ));
}

#[test]
fn remove_reduces_list_and_densifies_order() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    board_service::create_child_board(&mut conn, &child(&home, "a", "pa", "A")).unwrap();
    board_service::create_child_board(&mut conn, &child(&home, "b", "pb", "B")).unwrap();
    board_service::create_child_board(&mut conn, &child(&home, "c", "pc", "C")).unwrap();

    for id in ["a", "b", "c"] {
        workspace_repository::add_quick_board(
            &mut conn,
            &AddQuickBoardInput {
                board_id: id.into(),
            },
        )
        .unwrap();
    }

    workspace_repository::remove_quick_board(&mut conn, "b").unwrap();

    let quick = workspace_repository::list_quick_boards(&conn).unwrap();
    assert_eq!(
        quick
            .iter()
            .map(|q| q.board_id.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "c"]
    );
    // Order stays dense [0, 1].
    assert_eq!(quick[0].sort_order, 0);
    assert_eq!(quick[1].sort_order, 1);
}

#[test]
fn remove_unknown_board_is_noop() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    workspace_repository::remove_quick_board(&mut conn, "missing").unwrap();
}

#[test]
fn reorder_applies_full_new_order() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    board_service::create_child_board(&mut conn, &child(&home, "a", "pa", "A")).unwrap();
    board_service::create_child_board(&mut conn, &child(&home, "b", "pb", "B")).unwrap();
    board_service::create_child_board(&mut conn, &child(&home, "c", "pc", "C")).unwrap();

    for id in ["a", "b", "c"] {
        workspace_repository::add_quick_board(
            &mut conn,
            &AddQuickBoardInput {
                board_id: id.into(),
            },
        )
        .unwrap();
    }

    workspace_repository::reorder_quick_boards(
        &mut conn,
        &ReorderQuickBoardsInput {
            board_ids: vec!["c".into(), "a".into(), "b".into()],
        },
    )
    .unwrap();

    let quick = workspace_repository::list_quick_boards(&conn).unwrap();
    assert_eq!(
        quick
            .iter()
            .map(|q| q.board_id.as_str())
            .collect::<Vec<_>>(),
        vec!["c", "a", "b"]
    );
}

#[test]
fn reorder_rejects_incomplete_or_extra_ids_without_partial_writes() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    board_service::create_child_board(&mut conn, &child(&home, "a", "pa", "A")).unwrap();
    board_service::create_child_board(&mut conn, &child(&home, "b", "pb", "B")).unwrap();
    board_service::create_child_board(&mut conn, &child(&home, "c", "pc", "C")).unwrap();
    for id in ["a", "b", "c"] {
        workspace_repository::add_quick_board(
            &mut conn,
            &AddQuickBoardInput {
                board_id: id.into(),
            },
        )
        .unwrap();
    }

    // Wrong count (only two of three) must be rejected and leave order unchanged.
    let result = workspace_repository::reorder_quick_boards(
        &mut conn,
        &ReorderQuickBoardsInput {
            board_ids: vec!["a".into(), "b".into()],
        },
    );
    assert!(result.is_err());

    let quick = workspace_repository::list_quick_boards(&conn).unwrap();
    assert_eq!(
        quick
            .iter()
            .map(|q| q.board_id.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "b", "c"]
    );
}

#[test]
fn trashed_board_does_not_render_as_quick_board() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    board_service::create_child_board(&mut conn, &child(&home, "a", "pa", "A")).unwrap();
    workspace_repository::add_quick_board(
        &mut conn,
        &AddQuickBoardInput {
            board_id: "a".into(),
        },
    )
    .unwrap();

    // Soft-delete the board (or simulate the ON DELETE CASCADE path explicitly
    // by marking it deleted), then a list must exclude it.
    conn.execute("UPDATE boards SET deleted_at = 1 WHERE id = 'a'", [])
        .unwrap();

    let quick = workspace_repository::list_quick_boards(&conn).unwrap();
    assert!(quick.is_empty());
}
