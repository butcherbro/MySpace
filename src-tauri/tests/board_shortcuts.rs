//! Board shortcuts (todo.md №17): create/read on the canvas and Unsorted,
//! move between boards, trash cascade when the target (or an ancestor) is
//! trashed, restore, empty trash, and the defensive "broken shortcut" read
//! when the target row is gone without a cascade (stale/old data).

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::board_service;
use myspace_lib::domain::models::{
    CreateBoardShortcutInput, CreateChildBoardInput, Frame, MoveCardToBoardInput,
    MoveCardToUnsortedItem, MoveCardsToUnsortedInput, PlaceUnsortedCardInput, TrashItem,
    TrashSelectionInput,
};
use myspace_lib::domain::trash_service;
use myspace_lib::repositories::workspace_repository;
use rusqlite::Connection;

fn root_board_id(conn: &Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
}

fn frame() -> Frame {
    Frame {
        x: 10.0,
        y: 10.0,
        width: 120.0,
        height: 112.0,
    }
}

fn child(conn: &mut Connection, parent: &str, board_id: &str, portal_id: &str, title: &str) {
    board_service::create_child_board(
        conn,
        &CreateChildBoardInput {
            parent_board_id: parent.to_string(),
            board_id: board_id.to_string(),
            portal_card_id: portal_id.to_string(),
            frame: frame(),
            title: title.to_string(),
        },
    )
    .unwrap();
}

fn shortcut_target(card: &myspace_lib::domain::models::CardDto) -> Option<String> {
    match card {
        myspace_lib::domain::models::CardDto::BoardShortcut(s) => {
            s.target.as_ref().map(|t| t.id.clone())
        }
        other => panic!("expected a board shortcut, got {other:?}"),
    }
}

#[test]
fn create_and_read_shortcut_in_snapshot_and_unsorted() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    child(&mut conn, &home, "board-a", "portal-a", "Board A");

    let card = workspace_repository::create_board_shortcut(
        &mut conn,
        &CreateBoardShortcutInput {
            id: "shortcut-1".into(),
            board_id: home.clone(),
            frame: frame(),
            z_index: 1,
            target_board_id: "board-a".into(),
        },
    )
    .unwrap();
    assert_eq!(shortcut_target(&card).as_deref(), Some("board-a"));

    let snapshot = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    let found = snapshot
        .cards
        .iter()
        .find(|c| c.id() == "shortcut-1")
        .expect("shortcut present in canvas cards");
    assert_eq!(shortcut_target(found).as_deref(), Some("board-a"));

    // Renaming the target board is visible immediately (identity is read
    // live, never copied).
    board_service::rename_board(&mut conn, "board-a", "Board A renamed").unwrap();
    let reloaded = workspace_repository::load_card(&conn, "shortcut-1").unwrap();
    match reloaded {
        myspace_lib::domain::models::CardDto::BoardShortcut(s) => {
            assert_eq!(s.target.unwrap().title, "Board A renamed");
        }
        other => panic!("unexpected kind: {other:?}"),
    }

    // Move it into Unsorted and confirm it shows up there instead of on canvas.
    workspace_repository::move_cards_to_board_unsorted(
        &mut conn,
        &MoveCardsToUnsortedInput {
            target_board_id: home.clone(),
            cards: vec![MoveCardToUnsortedItem {
                id: "shortcut-1".into(),
                expected_revision: 1,
            }],
        },
    )
    .unwrap();
    let snapshot = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert!(!snapshot.cards.iter().any(|c| c.id() == "shortcut-1"));
    assert!(snapshot
        .unsorted_cards
        .iter()
        .any(|c| c.id() == "shortcut-1"));

    // Place it back on the canvas.
    workspace_repository::place_unsorted_card(
        &mut conn,
        &PlaceUnsortedCardInput {
            id: "shortcut-1".into(),
            expected_revision: 2,
            frame: frame(),
        },
    )
    .unwrap();
    let snapshot = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert!(snapshot.cards.iter().any(|c| c.id() == "shortcut-1"));
}

#[test]
fn create_shortcut_rejects_missing_target() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    let err = workspace_repository::create_board_shortcut(
        &mut conn,
        &CreateBoardShortcutInput {
            id: "shortcut-x".into(),
            board_id: home,
            frame: frame(),
            z_index: 0,
            target_board_id: "does-not-exist".into(),
        },
    )
    .unwrap_err();
    assert!(matches!(
        err,
        myspace_lib::domain::errors::WorkspaceError::NotFound(_)
    ));
}

#[test]
fn shortcut_can_be_moved_across_boards() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    child(&mut conn, &home, "board-a", "portal-a", "Board A");
    child(&mut conn, &home, "board-b", "portal-b", "Board B");

    workspace_repository::create_board_shortcut(
        &mut conn,
        &CreateBoardShortcutInput {
            id: "shortcut-1".into(),
            board_id: "board-a".into(),
            frame: frame(),
            z_index: 0,
            target_board_id: "board-b".into(),
        },
    )
    .unwrap();

    workspace_repository::move_card_to_board(
        &mut conn,
        &MoveCardToBoardInput {
            id: "shortcut-1".into(),
            expected_revision: 1,
            target_board_id: home.clone(),
            frame: Some(frame()),
        },
    )
    .unwrap();

    let snapshot = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert!(snapshot.cards.iter().any(|c| c.id() == "shortcut-1"));
}

#[test]
fn trashing_target_board_cascades_to_its_shortcuts() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    child(&mut conn, &home, "board-a", "portal-a", "Board A");

    workspace_repository::create_board_shortcut(
        &mut conn,
        &CreateBoardShortcutInput {
            id: "shortcut-1".into(),
            board_id: home.clone(),
            frame: frame(),
            z_index: 0,
            target_board_id: "board-a".into(),
        },
    )
    .unwrap();

    let batch_id = trash_service::trash_board(&mut conn, "board-a").unwrap();

    // The shortcut is gone from the active snapshot.
    let snapshot = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert!(!snapshot.cards.iter().any(|c| c.id() == "shortcut-1"));

    // It shows up trashed, in the SAME batch as the board.
    let trashed_batch: String = conn
        .query_row(
            "SELECT trash_batch_id FROM cards WHERE id = 'shortcut-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(trashed_batch, batch_id);

    // Restoring the batch brings both the board and the shortcut back.
    trash_service::restore_trash_batch(&mut conn, &batch_id).unwrap();
    let snapshot = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert!(snapshot.cards.iter().any(|c| c.id() == "shortcut-1"));
    let restored = workspace_repository::load_card(&conn, "shortcut-1").unwrap();
    assert_eq!(shortcut_target(&restored).as_deref(), Some("board-a"));
}

#[test]
fn trashing_an_ancestor_board_cascades_to_descendant_shortcuts() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    child(&mut conn, &home, "parent", "portal-parent", "Parent");
    child(&mut conn, "parent", "child", "portal-child", "Child");

    // A shortcut elsewhere (Home) pointing deep into the subtree that is
    // about to be trashed.
    workspace_repository::create_board_shortcut(
        &mut conn,
        &CreateBoardShortcutInput {
            id: "shortcut-deep".into(),
            board_id: home.clone(),
            frame: frame(),
            z_index: 0,
            target_board_id: "child".into(),
        },
    )
    .unwrap();

    let batch_id = trash_service::trash_board(&mut conn, "parent").unwrap();

    let deleted_at: Option<i64> = conn
        .query_row(
            "SELECT deleted_at FROM cards WHERE id = 'shortcut-deep'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        deleted_at.is_some(),
        "shortcut into a trashed grandchild board must cascade too"
    );

    trash_service::restore_trash_batch(&mut conn, &batch_id).unwrap();
    let snapshot = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert!(snapshot.cards.iter().any(|c| c.id() == "shortcut-deep"));
}

#[test]
fn trash_selection_of_a_leaf_shortcut_does_not_touch_the_target_board() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    child(&mut conn, &home, "board-a", "portal-a", "Board A");
    workspace_repository::create_board_shortcut(
        &mut conn,
        &CreateBoardShortcutInput {
            id: "shortcut-1".into(),
            board_id: home.clone(),
            frame: frame(),
            z_index: 0,
            target_board_id: "board-a".into(),
        },
    )
    .unwrap();

    trash_service::trash_selection(
        &mut conn,
        &TrashSelectionInput {
            items: vec![TrashItem {
                id: "shortcut-1".into(),
                kind: "board_shortcut".into(),
            }],
        },
    )
    .unwrap();

    // The board (and its portal) is untouched — only the shortcut is gone.
    let board_alive: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM boards WHERE id = 'board-a' AND deleted_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(board_alive, 1);
    let snapshot = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    assert!(!snapshot.cards.iter().any(|c| c.id() == "shortcut-1"));
    assert!(snapshot.cards.iter().any(|c| c.id() == "portal-a"));
}

#[test]
fn empty_trash_removes_trashed_shortcut_detail_rows() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    child(&mut conn, &home, "board-a", "portal-a", "Board A");
    workspace_repository::create_board_shortcut(
        &mut conn,
        &CreateBoardShortcutInput {
            id: "shortcut-1".into(),
            board_id: home.clone(),
            frame: frame(),
            z_index: 0,
            target_board_id: "board-a".into(),
        },
    )
    .unwrap();
    trash_service::trash_selection(
        &mut conn,
        &TrashSelectionInput {
            items: vec![TrashItem {
                id: "shortcut-1".into(),
                kind: "board_shortcut".into(),
            }],
        },
    )
    .unwrap();

    trash_service::empty_trash(&mut conn, "EMPTY").unwrap();

    let detail_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM board_shortcut_cards WHERE card_id = 'shortcut-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(detail_rows, 0);
    let card_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE id = 'shortcut-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(card_rows, 0);
}

#[test]
fn a_shortcut_whose_target_is_trashed_without_cascade_reads_as_broken() {
    // Simulates old/stale data (or a defensive edge case): the shortcut card
    // itself was never trashed, but its target board row is. The read must
    // degrade to `target: None`, not fail the whole snapshot.
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    child(&mut conn, &home, "board-a", "portal-a", "Board A");
    workspace_repository::create_board_shortcut(
        &mut conn,
        &CreateBoardShortcutInput {
            id: "shortcut-1".into(),
            board_id: home.clone(),
            frame: frame(),
            z_index: 0,
            target_board_id: "board-a".into(),
        },
    )
    .unwrap();

    // Directly mark the target board trashed without going through the
    // cascade-aware `trash_board`, to reproduce stale data.
    conn.execute(
        "UPDATE boards SET deleted_at = 999 WHERE id = 'board-a'",
        [],
    )
    .unwrap();

    let card = workspace_repository::load_card(&conn, "shortcut-1").unwrap();
    assert_eq!(shortcut_target(&card), None);

    let snapshot = workspace_repository::load_board_snapshot(&conn, &home).unwrap();
    let found = snapshot
        .cards
        .iter()
        .find(|c| c.id() == "shortcut-1")
        .unwrap();
    assert_eq!(shortcut_target(found), None);
}
