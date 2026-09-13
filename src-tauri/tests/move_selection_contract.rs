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
