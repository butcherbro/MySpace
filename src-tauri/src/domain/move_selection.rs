//! Mixed-selection move (ADR-0007). This module starts with the replay guard the
//! command and its receipt share; the atomic transaction lands here next.

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{MoveSelectionToBoardInput, MoveSelectionToBoardReceipt};
use crate::repositories::immediate_tx;
use std::collections::HashSet;

/// Canonical fingerprint of a mixed-selection request.
///
/// A replay of the same idempotency key must return the original receipt, while a
/// replay that reuses the key with a *different* payload must be rejected. The
/// fingerprint is the canonical JSON of the request rather than a hash: it needs
/// no hash dependency, and a stored hash is only useful if it is reproducible in
/// a later build, which `DefaultHasher` does not promise.
pub fn request_fingerprint(input: &MoveSelectionToBoardInput) -> Result<String, WorkspaceError> {
    // A struct serialises in declaration order, so the string is canonical.
    serde_json::to_string(input)
        .map_err(|error| WorkspaceError::Database(format!("cannot fingerprint request: {error}")))
}

/// The largest selection one atomic move accepts. A bounded payload keeps the
/// single write transaction predictable.
pub const MAX_SELECTION_ITEMS: usize = 500;

/// Rejects a request that must never open a write transaction: nothing selected,
/// more items than the bound, or a duplicated id (including the same id offered
/// as both a leaf and a board, which is nonsense input).
///
/// These checks need no database, so a malformed request is refused before the
/// transaction is even started. Kind-based checks — such as a Board Portal card
/// passed as a leaf — need the database and therefore belong to the transaction.
pub fn validate_selection_shape(input: &MoveSelectionToBoardInput) -> Result<(), WorkspaceError> {
    if input.cards.is_empty() && input.boards.is_empty() {
        return Err(WorkspaceError::ConstraintViolation(
            "the selection is empty; nothing to move".into(),
        ));
    }

    let total = input.cards.len() + input.boards.len();
    if total > MAX_SELECTION_ITEMS {
        return Err(WorkspaceError::ConstraintViolation(format!(
            "selection of {total} items exceeds the limit of {MAX_SELECTION_ITEMS}"
        )));
    }

    let mut seen = HashSet::with_capacity(total);
    for card in &input.cards {
        if !seen.insert(card.id.as_str()) {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "duplicate selection id: {}",
                card.id
            )));
        }
    }
    for board in &input.boards {
        if !seen.insert(board.board_id.as_str()) {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "duplicate selection id: {}",
                board.board_id
            )));
        }
    }

    Ok(())
}

/// The `operation_kind` every receipt of this operation is stored under.
pub const MOVE_SELECTION_OPERATION_KIND: &str = "move_selection_to_board";

/// Serialises a receipt for storage in `operation_receipts.receipt_json`.
pub fn encode_receipt(receipt: &MoveSelectionToBoardReceipt) -> Result<String, WorkspaceError> {
    serde_json::to_string(receipt)
        .map_err(|error| WorkspaceError::Database(format!("cannot encode receipt: {error}")))
}

/// Decodes a stored receipt. The replay path returns it unchanged, so the caller
/// must be able to hand the frontend exactly what the original call produced.
pub fn decode_receipt(json: &str) -> Result<MoveSelectionToBoardReceipt, WorkspaceError> {
    serde_json::from_str(json)
        .map_err(|error| WorkspaceError::Database(format!("cannot decode stored receipt: {error}")))
}

/// The pre-move state of one selected leaf: everything the receipt must record
/// and every expectation the transaction must check.
pub struct SelectedCardState {
    pub id: String,
    pub kind: String,
    pub board_id: String,
    pub unsorted: bool,
    pub frame: crate::domain::models::Frame,
    pub revision: i64,
}

/// The pre-move state of one selected board together with its unique portal.
pub struct SelectedBoardState {
    pub board_id: String,
    pub parent_board_id: Option<String>,
    pub board_revision: i64,
    pub portal_card_id: String,
    pub portal_frame: crate::domain::models::Frame,
    pub portal_revision: i64,
}

/// Everything an atomic mixed-selection move reads before it changes anything.
pub struct SelectionPreState {
    pub cards: Vec<SelectedCardState>,
    pub boards: Vec<SelectedBoardState>,
}

/// Rejects a selection that contains the destination board itself. Silently
/// dropping it would hide part of the selection from the user, so the whole
/// operation is refused and nothing is moved (ADR-0007).
pub fn validate_destination_not_selected(
    target_board_id: &str,
    state: &SelectionPreState,
) -> Result<(), WorkspaceError> {
    if state
        .boards
        .iter()
        .any(|board| board.board_id == target_board_id)
    {
        return Err(WorkspaceError::ConstraintViolation(
            "The selection contains the destination board. Nothing was moved.".into(),
        ));
    }
    Ok(())
}

/// Checks every expectation against the state read inside the transaction. Any
/// mismatch rejects the whole move before the first write, so a partially
/// applied selection is impossible.
pub fn validate_expectations(
    input: &MoveSelectionToBoardInput,
    state: &SelectionPreState,
) -> Result<(), WorkspaceError> {
    for expectation in &input.cards {
        let actual = state
            .cards
            .iter()
            .find(|card| card.id == expectation.id)
            .ok_or_else(|| WorkspaceError::NotFound(expectation.id.clone()))?;
        if actual.revision != expectation.expected_revision {
            return Err(WorkspaceError::StaleRevision {
                expected: expectation.expected_revision,
                actual: actual.revision,
            });
        }
    }

    for expectation in &input.boards {
        let actual = state
            .boards
            .iter()
            .find(|board| board.board_id == expectation.board_id)
            .ok_or_else(|| WorkspaceError::NotFound(expectation.board_id.clone()))?;
        if actual.board_revision != expectation.expected_board_revision {
            return Err(WorkspaceError::StaleRevision {
                expected: expectation.expected_board_revision,
                actual: actual.board_revision,
            });
        }
        if actual.portal_revision != expectation.expected_portal_revision {
            return Err(WorkspaceError::StaleRevision {
                expected: expectation.expected_portal_revision,
                actual: actual.portal_revision,
            });
        }
    }

    Ok(())
}

/// Moves a whole selection onto one board in a single Immediate transaction, or
/// changes nothing at all (ADR-0007).
///
/// The transaction is opened before anything is read, so no write can interleave
/// between validation and update. Every expectation is checked inside it, the
/// receipt is written with the same commit, and a replay of the same idempotency
/// key returns the original receipt instead of re-running the move.
pub fn move_selection_to_board(
    conn: &mut rusqlite::Connection,
    input: &MoveSelectionToBoardInput,
) -> Result<MoveSelectionToBoardReceipt, WorkspaceError> {
    use crate::domain::models::{
        Frame, MoveSelectionToBoardReceipt, MovedBoardReceipt, MovedCardReceipt,
    };
    use crate::repositories::workspace_repository as repo;
    use rusqlite::params;

    validate_selection_shape(input)?;
    let fingerprint = request_fingerprint(input)?;

    let now = crate::db::migrations::now_millis();
    // BEGIN IMMEDIATE before the replay guard: two writers replaying the same
    // key must not both miss the receipt and both apply the move.
    let tx = immediate_tx(conn)?;

    // Replay guard: the same key returns the receipt the first call produced.
    if let Some(stored) =
        repo::find_operation_receipt(&tx, MOVE_SELECTION_OPERATION_KIND, &input.idempotency_key)?
    {
        if stored.request_fingerprint != fingerprint {
            return Err(WorkspaceError::ConstraintViolation(
                "idempotency key reused with a different payload".into(),
            ));
        }
        return decode_receipt(&stored.receipt_json);
    }

    // Read and validate everything before the first write.
    let state = repo::read_selection_pre_state(&tx, input)?;
    validate_expectations(input, &state)?;
    validate_destination_not_selected(&input.target_board_id, &state)?;
    repo::validate_selection_cycle(&tx, &input.target_board_id, &state)?;

    let target_exists: i64 = tx.query_row(
        "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
        [input.target_board_id.as_str()],
        |row| row.get(0),
    )?;
    if target_exists == 0 {
        return Err(WorkspaceError::NotFound(input.target_board_id.clone()));
    }

    // Distinct slots are chosen before the leaves arrive, so the cascade is
    // computed against the destination as the user saw it.
    let heights: Vec<f64> = state
        .boards
        .iter()
        .map(|board| board.portal_frame.height)
        .collect();
    let slots =
        crate::domain::board_service::free_position_slots(&tx, &input.target_board_id, &heights);

    for card in &state.cards {
        let changed = tx.execute(
            "UPDATE cards SET board_id = ?1, unsorted = 1, revision = revision + 1, updated_at = ?2
             WHERE id = ?3 AND revision = ?4",
            params![input.target_board_id, now, card.id, card.revision],
        )?;
        if changed == 0 {
            return Err(WorkspaceError::StaleRevision {
                expected: card.revision,
                actual: card.revision,
            });
        }
    }

    let mut receipt_boards = Vec::with_capacity(state.boards.len());
    for (board, slot) in state.boards.iter().zip(slots.iter()) {
        let moved = tx.execute(
            "UPDATE boards SET parent_board_id = ?1, revision = revision + 1, updated_at = ?2
             WHERE id = ?3 AND revision = ?4",
            params![
                input.target_board_id,
                now,
                board.board_id,
                board.board_revision
            ],
        )?;
        if moved == 0 {
            return Err(WorkspaceError::StaleRevision {
                expected: board.board_revision,
                actual: board.board_revision,
            });
        }
        let moved_portal = tx.execute(
            "UPDATE cards SET board_id = ?1, x = ?2, y = ?3, revision = revision + 1, updated_at = ?4
             WHERE id = ?5 AND revision = ?6",
            params![
                input.target_board_id,
                slot.0,
                slot.1,
                now,
                board.portal_card_id,
                board.portal_revision
            ],
        )?;
        if moved_portal == 0 {
            return Err(WorkspaceError::StaleRevision {
                expected: board.portal_revision,
                actual: board.portal_revision,
            });
        }
        receipt_boards.push(MovedBoardReceipt {
            board_id: board.board_id.clone(),
            portal_card_id: board.portal_card_id.clone(),
            previous_parent_board_id: board.parent_board_id.clone().unwrap_or_default(),
            previous_portal_frame: board.portal_frame,
            destination_portal_frame: Frame {
                x: slot.0,
                y: slot.1,
                width: board.portal_frame.width,
                height: board.portal_frame.height,
            },
            before_board_revision: board.board_revision,
            after_board_revision: board.board_revision + 1,
            before_portal_revision: board.portal_revision,
            after_portal_revision: board.portal_revision + 1,
        });
    }

    let receipt = MoveSelectionToBoardReceipt {
        operation_id: uuid::Uuid::now_v7().to_string(),
        target_board_id: input.target_board_id.clone(),
        cards: state
            .cards
            .iter()
            .map(|card| MovedCardReceipt {
                id: card.id.clone(),
                previous_board_id: card.board_id.clone(),
                previous_unsorted: card.unsorted,
                previous_frame: card.frame,
                before_revision: card.revision,
                after_revision: card.revision + 1,
            })
            .collect(),
        boards: receipt_boards,
    };

    repo::store_operation_receipt(
        &tx,
        &receipt.operation_id,
        MOVE_SELECTION_OPERATION_KIND,
        &input.idempotency_key,
        &fingerprint,
        &encode_receipt(&receipt)?,
        now,
    )?;
    tx.commit()?;

    Ok(receipt)
}

/// Reverses one mixed-selection move from its receipt: a second Immediate
/// transaction that is itself all-or-nothing.
///
/// The receipt carries the post-move revisions, so an undo against a selection
/// somebody changed afterwards is refused instead of restoring half of it. Undo
/// must not loop over the older single-entity commands, which cannot be atomic
/// together (ADR-0007).
pub fn undo_move_selection(
    conn: &mut rusqlite::Connection,
    receipt: &MoveSelectionToBoardReceipt,
) -> Result<(), WorkspaceError> {
    use rusqlite::params;

    let now = crate::db::migrations::now_millis();
    let tx = immediate_tx(conn)?;

    for card in &receipt.cards {
        let restored = tx.execute(
            "UPDATE cards SET board_id = ?1, unsorted = ?2, x = ?3, y = ?4, revision = revision + 1, updated_at = ?5
             WHERE id = ?6 AND revision = ?7",
            params![
                card.previous_board_id,
                if card.previous_unsorted { 1 } else { 0 },
                card.previous_frame.x,
                card.previous_frame.y,
                now,
                card.id,
                card.after_revision
            ],
        )?;
        if restored == 0 {
            // Раньше здесь дублировали after_revision в оба поля — тост всегда
            // показывал "actual N, expected N" и не давал понять, что реально
            // разошлось. Читаем настоящую текущую ревизию из БД, как это уже
            // делает update_note.
            let actual: i64 = tx
                .query_row(
                    "SELECT revision FROM cards WHERE id = ?1",
                    [card.id.as_str()],
                    |r| r.get(0),
                )
                .unwrap_or(card.after_revision);
            return Err(WorkspaceError::StaleRevision {
                expected: card.after_revision,
                actual,
            });
        }
    }

    for board in &receipt.boards {
        let restored_board = tx.execute(
            "UPDATE boards SET parent_board_id = ?1, revision = revision + 1, updated_at = ?2
             WHERE id = ?3 AND revision = ?4",
            params![
                board.previous_parent_board_id,
                now,
                board.board_id,
                board.after_board_revision
            ],
        )?;
        if restored_board == 0 {
            let actual: i64 = tx
                .query_row(
                    "SELECT revision FROM boards WHERE id = ?1",
                    [board.board_id.as_str()],
                    |r| r.get(0),
                )
                .unwrap_or(board.after_board_revision);
            return Err(WorkspaceError::StaleRevision {
                expected: board.after_board_revision,
                actual,
            });
        }
        let restored_portal = tx.execute(
            "UPDATE cards SET board_id = ?1, x = ?2, y = ?3, revision = revision + 1, updated_at = ?4
             WHERE id = ?5 AND revision = ?6",
            params![
                board.previous_parent_board_id,
                board.previous_portal_frame.x,
                board.previous_portal_frame.y,
                now,
                board.portal_card_id,
                board.after_portal_revision
            ],
        )?;
        if restored_portal == 0 {
            let actual: i64 = tx
                .query_row(
                    "SELECT revision FROM cards WHERE id = ?1",
                    [board.portal_card_id.as_str()],
                    |r| r.get(0),
                )
                .unwrap_or(board.after_portal_revision);
            return Err(WorkspaceError::StaleRevision {
                expected: board.after_portal_revision,
                actual,
            });
        }
    }

    tx.commit()?;
    Ok(())
}
