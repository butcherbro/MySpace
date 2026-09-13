# ADR-0007: One Atomic Command for a Mixed Selection Move

- **Status:** Accepted (architect verdict: APPROVED WITH CHANGES, 2026-09-13)
- **Date:** 2026-09-13
- **Source:** checkpoint MIXED-GROUP-MOVE of
  `docs/plans/2026-09-11-v1-stabilization-and-debt-paydown.md`
- **Decides:** the backend contract for Task 10

## Context

A mixed group drop (leaf cards plus Board Portals) onto a tab, breadcrumb or Board
Portal is handled today by two independent paths: one
`move_cards_to_board_unsorted` batch for the leaves and one fire-and-forget
`MoveBoardCommand` per portal. A partial failure leaves the selection half moved,
and undo is assembled from N unrelated actions.

The architect ruled that a UI-only prohibition of mixed drops is not justified:
the backend already has the primitives, and the defect affects at least two user
paths.

## Decision

One atomic Rust command replaces both mixed paths: `handleCardsDroppedOnBoard` and
the group branch in `handleCardDragEnd`.

### Input

```rust
MoveSelectionToBoardInput {
    idempotency_key: String,
    target_board_id: String,
    cards: Vec<MoveSelectionCard { id: String, expected_revision: i64 }>,
    boards: Vec<MoveSelectionBoard {
        board_id: String,
        expected_board_revision: i64,
        expected_portal_revision: i64,
    }>,
    leaf_placement: Unsorted,
}
```

Corrections to the first proposal:

- no `portal_card_id`: the backend resolves the portal by `board_id`, as
  `move_board` already does;
- no frontend-supplied frame for a portal moved directly: the backend picks a free
  position;
- no general `Frame` placement for leaves: one frame is ambiguous for a group;
- `idempotency_key` added;
- selection size bounded (for example 500 elements).

### Behaviour on the destination board's own portal

Reject the whole operation with a `ConstraintViolation` such as
`The selection contains the destination board. Nothing was moved.` Silently
dropping the item would hide part of the selection from the user. The current
frontend filters (`targetBoardId !== target`) must be removed so the backend
actually sees the offending entity.

### Receipt (mandatory)

One call changes several aggregates and the IPC response can be lost after a
successful commit, so a replay with the same key must return the original receipt
rather than hit a stale revision. An ID-only receipt is insufficient for undo.

```rust
MoveSelectionToBoardReceipt {
    operation_id: String,
    target_board_id: String,
    cards: Vec<MovedCardReceipt {
        id, previous_board_id, previous_unsorted, previous_frame,
        before_revision, after_revision,
    }>,
    boards: Vec<MovedBoardReceipt {
        board_id, portal_card_id, previous_parent_board_id, previous_portal_frame,
        destination_portal_frame, before_board_revision, after_board_revision,
        before_portal_revision, after_portal_revision,
    }>,
}
```

Undo is a **second atomic backend operation** driven by the receipt and expected
post-move revisions. It must not loop over existing commands.

### Mandatory implementation rules

1. Begin `TransactionBehavior::Immediate` before reading and validation, so no
   race remains between validation and update.
2. Validate target, every entity, kinds, revisions, workspace, root and cycles
   inside the transaction.
3. Reject empty lists, duplicate ids, and a portal card passed as a leaf.
4. Allocate distinct free positions for several portals deterministically; the
   free-position search must account for portals already planned in this
   transaction.
5. Write the mutation receipt in the same transaction.
6. Reject a replay with the same key and a different payload; store a request
   fingerprint.
7. Do not squeeze the result into the existing `mutation_receipts.card_ids`: use a
   new general receipt schema (or table) carrying `operation_kind`,
   `request_fingerprint` and `receipt_json`.
8. After commit the frontend updates state from the receipt, not by assuming
   `revision + 1` and coordinates itself.

## Known defect to fix in the same task

`move_board` (`src-tauri/src/domain/board_service.rs:225`) ignores
`MoveBoardInput.frame` and computes `next_free_position`, so the existing
`MoveBoardCommand.undo()` does not reliably restore a portal's original position.
Cover it with a test and fix it in Task 10 (or in a preceding commit).

## Test matrix

The matrix from the plan plus: duplicate leaf/board id; portal id passed as a leaf;
selected destination board; two portals receive different positions; replay with
the same key and the same payload; replay with the same key and a different
payload; atomic undo; stale revision during undo; restoration of the original
`board_id`, `unsorted`, frames and revisions; both UI entrances (tab and
portal/breadcrumb).
