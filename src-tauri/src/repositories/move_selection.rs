//! Pre-move reads for a mixed selection (ADR-0007). They run inside the
//! caller's Immediate transaction, so the values cannot change under the caller.

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::errors::WorkspaceError;
use crate::domain::models::Frame;

/// Reads the pre-move state of a mixed selection. It runs inside the caller's
/// Immediate transaction, so the values cannot change under the caller, and it
/// rejects a leaf that is missing or trashed, a Board Portal offered as a leaf,
/// and a board without an active portal (ADR-0007 rules 2-3).
pub fn read_selection_pre_state(
    conn: &Connection,
    input: &crate::domain::models::MoveSelectionToBoardInput,
) -> Result<crate::domain::move_selection::SelectionPreState, WorkspaceError> {
    use crate::domain::move_selection::{SelectedBoardState, SelectedCardState, SelectionPreState};

    let mut cards = Vec::with_capacity(input.cards.len());
    for item in &input.cards {
        let state = conn
            .query_row(
                "SELECT kind, board_id, x, y, width, height, unsorted, revision FROM cards
                 WHERE id = ?1 AND deleted_at IS NULL",
                [item.id.as_str()],
                |row| {
                    Ok(SelectedCardState {
                        id: item.id.clone(),
                        kind: row.get(0)?,
                        board_id: row.get(1)?,
                        frame: Frame {
                            x: row.get(2)?,
                            y: row.get(3)?,
                            width: row.get(4)?,
                            height: row.get(5)?,
                        },
                        unsorted: row.get::<_, i64>(6)? == 1,
                        revision: row.get(7)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| WorkspaceError::NotFound(item.id.clone()))?;
        if state.kind == "board_portal" {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "board portal {} must be moved as a board, not as a leaf",
                item.id
            )));
        }
        cards.push(state);
    }

    let mut boards = Vec::with_capacity(input.boards.len());
    for item in &input.boards {
        let (parent_board_id, board_revision): (Option<String>, i64) = conn
            .query_row(
                "SELECT parent_board_id, revision FROM boards WHERE id = ?1 AND deleted_at IS NULL",
                [item.board_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| WorkspaceError::NotFound(item.board_id.clone()))?;
        let (portal_card_id, portal_frame, portal_revision) = conn
            .query_row(
                "SELECT c.id, c.x, c.y, c.width, c.height, c.revision
                 FROM board_portal_cards p JOIN cards c ON c.id = p.card_id
                 WHERE p.target_board_id = ?1 AND c.deleted_at IS NULL",
                [item.board_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        Frame {
                            x: row.get(1)?,
                            y: row.get(2)?,
                            width: row.get(3)?,
                            height: row.get(4)?,
                        },
                        row.get(5)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| {
                WorkspaceError::ConstraintViolation(format!(
                    "board {} has no active portal card",
                    item.board_id
                ))
            })?;
        boards.push(SelectedBoardState {
            board_id: item.board_id.clone(),
            parent_board_id,
            board_revision,
            portal_card_id,
            portal_frame,
            portal_revision,
        });
    }

    Ok(SelectionPreState { cards, boards })
}

/// True when `candidate_board_id` lies inside the subtree rooted at
/// `root_board_id` (the root itself counts).
fn is_in_subtree(
    conn: &Connection,
    root_board_id: &str,
    candidate_board_id: &str,
) -> Result<bool, WorkspaceError> {
    let count: i64 = conn.query_row(
        "WITH RECURSIVE subtree(id) AS (
            SELECT id FROM boards WHERE id = ?1
            UNION ALL
            SELECT b.id FROM boards b JOIN subtree s ON b.parent_board_id = s.id
         )
         SELECT COUNT(*) FROM subtree WHERE id = ?2",
        params![root_board_id, candidate_board_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Rejects a mixed-selection move that would detach a subtree from the workspace
/// root: the root board may not travel at all, and the destination may not sit
/// inside a board that moves with the selection (ADR-0007 rule 2).
pub fn validate_selection_cycle(
    conn: &Connection,
    target_board_id: &str,
    state: &crate::domain::move_selection::SelectionPreState,
) -> Result<(), WorkspaceError> {
    for board in &state.boards {
        if board.parent_board_id.is_none() {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "board {} is the workspace root and cannot be moved",
                board.board_id
            )));
        }
        if is_in_subtree(conn, &board.board_id, target_board_id)? {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "board {} cannot be moved inside its own subtree",
                board.board_id
            )));
        }
    }
    Ok(())
}
