//! Wire contract for the atomic mixed-selection move (ADR-0007). The frontend
//! and the undo path both read these field names, so a rename here is an IPC break.

use myspace_lib::domain::models::{
    Frame, MoveSelectionBoard, MoveSelectionCard, MoveSelectionToBoardInput,
    MoveSelectionToBoardReceipt, MovedBoardReceipt, MovedCardReceipt, SelectionLeafPlacement,
};
use myspace_lib::domain::move_selection::request_fingerprint;

fn sample_input() -> MoveSelectionToBoardInput {
    MoveSelectionToBoardInput {
        idempotency_key: "op-1".into(),
        target_board_id: "board-b".into(),
        cards: vec![MoveSelectionCard {
            id: "n1".into(),
            expected_revision: 3,
        }],
        boards: vec![MoveSelectionBoard {
            board_id: "board-a".into(),
            expected_board_revision: 5,
            expected_portal_revision: 7,
        }],
        leaf_placement: SelectionLeafPlacement::Unsorted,
    }
}

#[test]
fn request_fingerprint_is_stable_and_payload_sensitive() {
    let base = sample_input();
    assert_eq!(
        request_fingerprint(&base).unwrap(),
        request_fingerprint(&sample_input()).unwrap(),
        "an identical payload fingerprints identically"
    );

    let mut different_card = sample_input();
    different_card.cards[0].expected_revision = 99;
    assert_ne!(
        request_fingerprint(&base).unwrap(),
        request_fingerprint(&different_card).unwrap(),
        "a reused key with a different card revision must fingerprint differently"
    );

    let mut different_boards = sample_input();
    different_boards.boards[0].expected_portal_revision = 8;
    assert_ne!(
        request_fingerprint(&base).unwrap(),
        request_fingerprint(&different_boards).unwrap(),
        "a reused key with different board expectations must fingerprint differently"
    );
}

#[test]
fn request_fingerprint_covers_the_idempotency_key() {
    let mut other_key = sample_input();
    other_key.idempotency_key = "op-2".into();
    assert_ne!(
        request_fingerprint(&sample_input()).unwrap(),
        request_fingerprint(&other_key).unwrap()
    );
}

#[test]
fn selection_shape_rejects_empty_duplicate_and_oversized_requests() {
    use myspace_lib::domain::errors::WorkspaceError;
    use myspace_lib::domain::move_selection::{validate_selection_shape, MAX_SELECTION_ITEMS};

    // A well-formed mixed selection passes.
    assert!(validate_selection_shape(&sample_input()).is_ok());

    // Nothing selected at all.
    let mut empty = sample_input();
    empty.cards.clear();
    empty.boards.clear();
    assert!(matches!(
        validate_selection_shape(&empty),
        Err(WorkspaceError::ConstraintViolation(_))
    ));

    // A duplicated leaf id would move the same card twice.
    let mut duplicate_card = sample_input();
    duplicate_card.cards.push(MoveSelectionCard {
        id: "n1".into(),
        expected_revision: 4,
    });
    assert!(matches!(
        validate_selection_shape(&duplicate_card),
        Err(WorkspaceError::ConstraintViolation(_))
    ));

    // A duplicated board id would reparent the same board twice.
    let mut duplicate_board = sample_input();
    duplicate_board.boards.push(MoveSelectionBoard {
        board_id: "board-a".into(),
        expected_board_revision: 6,
        expected_portal_revision: 8,
    });
    assert!(matches!(
        validate_selection_shape(&duplicate_board),
        Err(WorkspaceError::ConstraintViolation(_))
    ));

    // The same id offered as both a leaf and a board is nonsense.
    let mut same_id_twice = sample_input();
    same_id_twice.boards[0].board_id = "n1".into();
    assert!(matches!(
        validate_selection_shape(&same_id_twice),
        Err(WorkspaceError::ConstraintViolation(_))
    ));

    // Beyond the bound.
    let mut oversized = sample_input();
    oversized.boards.clear();
    oversized.cards = (0..=MAX_SELECTION_ITEMS)
        .map(|index| MoveSelectionCard {
            id: format!("c{index}"),
            expected_revision: 1,
        })
        .collect();
    assert!(matches!(
        validate_selection_shape(&oversized),
        Err(WorkspaceError::ConstraintViolation(_))
    ));
}

#[test]
fn selection_shape_accepts_a_boards_only_selection() {
    use myspace_lib::domain::move_selection::validate_selection_shape;

    let mut boards_only = sample_input();
    boards_only.cards.clear();
    assert!(validate_selection_shape(&boards_only).is_ok());
}

fn frame(x: f64, y: f64) -> Frame {
    Frame {
        x,
        y,
        width: 120.0,
        height: 112.0,
    }
}

#[test]
fn mixed_selection_input_serializes_with_camel_case_keys() {
    let input = MoveSelectionToBoardInput {
        idempotency_key: "op-1".into(),
        target_board_id: "board-b".into(),
        cards: vec![MoveSelectionCard {
            id: "n1".into(),
            expected_revision: 3,
        }],
        boards: vec![MoveSelectionBoard {
            board_id: "board-a".into(),
            expected_board_revision: 5,
            expected_portal_revision: 7,
        }],
        leaf_placement: SelectionLeafPlacement::Unsorted,
    };

    let json = serde_json::to_value(&input).unwrap();
    assert_eq!(json["idempotencyKey"], "op-1");
    assert_eq!(json["targetBoardId"], "board-b");
    assert_eq!(json["cards"][0]["expectedRevision"], 3);
    assert_eq!(json["boards"][0]["boardId"], "board-a");
    assert_eq!(json["boards"][0]["expectedBoardRevision"], 5);
    assert_eq!(json["boards"][0]["expectedPortalRevision"], 7);
    assert_eq!(json["leafPlacement"], "unsorted");

    // The backend never trusts a frontend-supplied portal id or frame.
    assert!(json["boards"][0].get("portalCardId").is_none());
    assert!(json["boards"][0].get("frame").is_none());

    let back: MoveSelectionToBoardInput = serde_json::from_value(json).unwrap();
    assert_eq!(back, input);
}

#[test]
fn receipt_round_trips_both_card_and_board_entries() {
    let receipt = MoveSelectionToBoardReceipt {
        operation_id: "op-1".into(),
        target_board_id: "board-b".into(),
        cards: vec![MovedCardReceipt {
            id: "n1".into(),
            previous_board_id: "home".into(),
            previous_unsorted: false,
            previous_frame: frame(1.0, 2.0),
            before_revision: 3,
            after_revision: 4,
        }],
        boards: vec![MovedBoardReceipt {
            board_id: "board-a".into(),
            portal_card_id: "pa".into(),
            previous_parent_board_id: "home".into(),
            previous_portal_frame: frame(0.0, 0.0),
            destination_portal_frame: frame(40.0, 40.0),
            before_board_revision: 5,
            after_board_revision: 6,
            before_portal_revision: 7,
            after_portal_revision: 8,
        }],
    };

    let json = serde_json::to_value(&receipt).unwrap();
    assert_eq!(json["operationId"], "op-1");
    assert_eq!(json["cards"][0]["previousBoardId"], "home");
    assert_eq!(json["cards"][0]["previousUnsorted"], false);
    assert_eq!(json["cards"][0]["beforeRevision"], 3);
    assert_eq!(json["cards"][0]["afterRevision"], 4);
    assert_eq!(json["boards"][0]["portalCardId"], "pa");
    assert_eq!(json["boards"][0]["previousParentBoardId"], "home");
    assert_eq!(json["boards"][0]["destinationPortalFrame"]["x"], 40.0);
    assert_eq!(json["boards"][0]["beforePortalRevision"], 7);
    assert_eq!(json["boards"][0]["afterPortalRevision"], 8);

    let back: MoveSelectionToBoardReceipt = serde_json::from_value(json).unwrap();
    assert_eq!(back, receipt);
}

const RECEIPT_KIND: &str = "move_selection_to_board";

#[test]
fn operation_receipts_store_find_and_roll_back_with_the_transaction() {
    use myspace_lib::db::{bootstrap, open_in_memory};
    use myspace_lib::repositories::workspace_repository::{
        find_operation_receipt, store_operation_receipt,
    };

    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();

    assert!(find_operation_receipt(&conn, RECEIPT_KIND, "op-1")
        .unwrap()
        .is_none());

    let tx = conn.transaction().unwrap();
    store_operation_receipt(
        &tx,
        "operation-1",
        RECEIPT_KIND,
        "op-1",
        "{\"fingerprint\":1}",
        "{\"cards\":[]}",
        42,
    )
    .unwrap();
    tx.commit().unwrap();

    let found = find_operation_receipt(&conn, RECEIPT_KIND, "op-1")
        .unwrap()
        .expect("a committed receipt is found");
    assert_eq!(found.operation_id, "operation-1");
    assert_eq!(found.request_fingerprint, "{\"fingerprint\":1}");
    assert_eq!(found.receipt_json, "{\"cards\":[]}");

    // The unique (kind, key) index rejects a second store for the same key.
    let tx = conn.transaction().unwrap();
    assert!(
        store_operation_receipt(&tx, "operation-2", RECEIPT_KIND, "op-1", "x", "{}", 43).is_err()
    );
    drop(tx);

    // A rolled-back operation leaves no receipt, so a failed move stays retryable.
    let tx = conn.transaction().unwrap();
    store_operation_receipt(&tx, "operation-3", RECEIPT_KIND, "op-2", "y", "{}", 44).unwrap();
    drop(tx);
    assert!(find_operation_receipt(&conn, RECEIPT_KIND, "op-2")
        .unwrap()
        .is_none());
}

#[test]
fn receipt_encodes_and_decodes_unchanged_for_the_replay_path() {
    use myspace_lib::domain::move_selection::{
        decode_receipt, encode_receipt, MOVE_SELECTION_OPERATION_KIND,
    };

    let receipt = MoveSelectionToBoardReceipt {
        operation_id: "operation-1".into(),
        target_board_id: "board-b".into(),
        cards: vec![MovedCardReceipt {
            id: "n1".into(),
            previous_board_id: "home".into(),
            previous_unsorted: true,
            previous_frame: frame(5.0, 6.0),
            before_revision: 3,
            after_revision: 4,
        }],
        boards: vec![MovedBoardReceipt {
            board_id: "board-a".into(),
            portal_card_id: "pa".into(),
            previous_parent_board_id: "home".into(),
            previous_portal_frame: frame(0.0, 0.0),
            destination_portal_frame: frame(40.0, 40.0),
            before_board_revision: 5,
            after_board_revision: 6,
            before_portal_revision: 7,
            after_portal_revision: 8,
        }],
    };

    let encoded = encode_receipt(&receipt).unwrap();
    assert_eq!(decode_receipt(&encoded).unwrap(), receipt);
    assert_eq!(MOVE_SELECTION_OPERATION_KIND, "move_selection_to_board");
    assert!(decode_receipt("not json").is_err());
}

#[test]
fn pre_state_reads_frames_unsorted_and_rejects_bad_leaves() {
    use myspace_lib::db::{bootstrap, open_in_memory};
    use myspace_lib::domain::errors::WorkspaceError;
    use myspace_lib::repositories::workspace_repository::read_selection_pre_state;

    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home: String = conn
        .query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();

    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, unsorted, created_at, updated_at) VALUES ('placed', ?1, 'note', 10, 20, 200, 80, 0, 4, 0, 0, 0)",
        [home.clone()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, unsorted, created_at, updated_at) VALUES ('loose', ?1, 'note', 0, 0, 200, 80, 0, 2, 1, 0, 0)",
        [home.clone()],
    )
    .unwrap();

    let mut input = sample_input();
    input.boards.clear();
    input.cards = vec![
        MoveSelectionCard {
            id: "placed".into(),
            expected_revision: 4,
        },
        MoveSelectionCard {
            id: "loose".into(),
            expected_revision: 2,
        },
    ];
    let state = read_selection_pre_state(&conn, &input).unwrap();
    assert_eq!(state.cards.len(), 2);
    assert_eq!(state.cards[0].board_id, home);
    assert_eq!(state.cards[0].frame.x, 10.0);
    assert_eq!(state.cards[0].frame.height, 80.0);
    assert_eq!(state.cards[0].revision, 4);
    assert!(!state.cards[0].unsorted, "a placed card is not unsorted");
    assert!(state.cards[1].unsorted, "an unsorted card keeps its flag");

    let mut missing = sample_input();
    missing.boards.clear();
    missing.cards = vec![MoveSelectionCard {
        id: "nope".into(),
        expected_revision: 1,
    }];
    assert!(matches!(
        read_selection_pre_state(&conn, &missing),
        Err(WorkspaceError::NotFound(_))
    ));

    conn.execute(
        "INSERT INTO boards (id, workspace_id, parent_board_id, title, color_token, symbol, revision, created_at, updated_at) SELECT 'child', w.id, w.root_board_id, 'Child', 'default', NULL, 1, 0, 0 FROM workspaces w",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, unsorted, created_at, updated_at) VALUES ('portal', ?1, 'board_portal', 0, 0, 120, 112, 0, 1, 0, 0, 0)",
        [home.clone()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO board_portal_cards (card_id, target_board_id) VALUES ('portal', 'child')",
        [],
    )
    .unwrap();

    let mut portal_as_leaf = sample_input();
    portal_as_leaf.boards.clear();
    portal_as_leaf.cards = vec![MoveSelectionCard {
        id: "portal".into(),
        expected_revision: 1,
    }];
    assert!(matches!(
        read_selection_pre_state(&conn, &portal_as_leaf),
        Err(WorkspaceError::ConstraintViolation(_))
    ));

    let mut as_board = sample_input();
    as_board.cards.clear();
    as_board.boards = vec![MoveSelectionBoard {
        board_id: "child".into(),
        expected_board_revision: 1,
        expected_portal_revision: 1,
    }];
    let state = read_selection_pre_state(&conn, &as_board).unwrap();
    assert_eq!(state.boards.len(), 1);
    assert_eq!(state.boards[0].portal_card_id, "portal");
    assert_eq!(state.boards[0].portal_frame.width, 120.0);
    assert_eq!(
        state.boards[0].parent_board_id.as_deref(),
        Some(home.as_str())
    );
}

#[test]
fn expectations_validate_revisions_and_reject_the_destination_board() {
    use myspace_lib::domain::errors::WorkspaceError;
    use myspace_lib::domain::move_selection::{
        validate_destination_not_selected, validate_expectations, SelectedBoardState,
        SelectedCardState, SelectionPreState,
    };

    let state = SelectionPreState {
        cards: vec![SelectedCardState {
            id: "n1".into(),
            kind: "note".into(),
            board_id: "home".into(),
            unsorted: false,
            frame: frame(1.0, 2.0),
            revision: 3,
        }],
        boards: vec![SelectedBoardState {
            board_id: "board-a".into(),
            parent_board_id: Some("home".into()),
            board_revision: 5,
            portal_card_id: "pa".into(),
            portal_frame: frame(0.0, 0.0),
            portal_revision: 7,
        }],
    };

    assert!(validate_expectations(&sample_input(), &state).is_ok());

    let mut stale_leaf = sample_input();
    stale_leaf.cards[0].expected_revision = 4;
    assert!(matches!(
        validate_expectations(&stale_leaf, &state),
        Err(WorkspaceError::StaleRevision { .. })
    ));

    let mut stale_board = sample_input();
    stale_board.boards[0].expected_board_revision = 6;
    assert!(matches!(
        validate_expectations(&stale_board, &state),
        Err(WorkspaceError::StaleRevision { .. })
    ));

    let mut stale_portal = sample_input();
    stale_portal.boards[0].expected_portal_revision = 8;
    assert!(matches!(
        validate_expectations(&stale_portal, &state),
        Err(WorkspaceError::StaleRevision { .. })
    ));

    // A selection that somehow still carries the destination board is refused.
    assert!(validate_destination_not_selected("board-b", &state).is_ok());
    let target_in_selection = SelectionPreState {
        cards: vec![],
        boards: vec![SelectedBoardState {
            board_id: "board-b".into(),
            parent_board_id: Some("home".into()),
            board_revision: 1,
            portal_card_id: "pb".into(),
            portal_frame: frame(0.0, 0.0),
            portal_revision: 1,
        }],
    };
    match validate_destination_not_selected("board-b", &target_in_selection) {
        Err(WorkspaceError::ConstraintViolation(message)) => {
            assert!(message.contains("destination board"), "got: {message}");
        }
        other => panic!("expected a ConstraintViolation, got {other:?}"),
    }
}
