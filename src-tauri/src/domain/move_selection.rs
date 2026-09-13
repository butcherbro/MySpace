//! Mixed-selection move (ADR-0007). This module starts with the replay guard the
//! command and its receipt share; the atomic transaction lands here next.

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{MoveSelectionToBoardInput, MoveSelectionToBoardReceipt};
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
