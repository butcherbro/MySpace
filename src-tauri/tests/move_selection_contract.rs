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
