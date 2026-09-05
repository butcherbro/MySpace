//! The concrete application service layer.
//!
//! `WorkspaceService` is the single typed boundary above repositories and domain
//! services. Tauri commands and the MCP stdio adapter both call into it, so
//! business rules (entity addressing, idempotency, batch identity) live in one
//! place (ADR-0005). It is concrete, not a trait, and accepts `&Conn`/`&mut Conn`
//! so adapters own the actual SQLite connection lifecycle.

use rusqlite::Connection;

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{
    BoardSnapshot, BoardSummary, CardDto, CreateLinkBatchInput, CreateLinkBatchResult, TrashItem,
    TrashSelectionInput,
};
use crate::domain::trash_service;
use crate::repositories::workspace_repository;

/// A resolved entity address of the form `myspace://<kind>/<id>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntityAddress {
    Board(String),
    Card(String),
    Asset(String),
}

/// Parses a `myspace://<kind>/<id>` address into its entity parts.
pub fn parse_address(address: &str) -> Result<(String, String), WorkspaceError> {
    let rest = address.strip_prefix("myspace://").ok_or_else(|| {
        WorkspaceError::ConstraintViolation(format!("invalid address: {address}"))
    })?;
    let mut parts = rest.split('/');
    let kind = parts
        .next()
        .ok_or_else(|| WorkspaceError::ConstraintViolation("missing address kind".into()))?
        .to_string();
    let id = parts
        .next()
        .ok_or_else(|| WorkspaceError::ConstraintViolation("missing address id".into()))?
        .to_string();
    if parts.next().is_some() {
        return Err(WorkspaceError::ConstraintViolation(format!(
            "invalid address: {address}"
        )));
    }
    if !["board", "card", "asset"].contains(&kind.as_str()) {
        return Err(WorkspaceError::ConstraintViolation(format!(
            "unknown address kind: {kind}"
        )));
    }
    Ok((kind, id))
}

/// The typed application service.
pub struct WorkspaceService;

impl WorkspaceService {
    /// Lists all active boards.
    pub fn list_boards(conn: &Connection) -> Result<Vec<BoardSummary>, WorkspaceError> {
        workspace_repository::list_boards(conn)
    }

    /// Resolves an entity address to a board summary (for `myspace://board/<id>`).
    pub fn resolve_board(conn: &Connection, address: &str) -> Result<BoardSummary, WorkspaceError> {
        let (kind, id) = parse_address(address)?;
        if kind != "board" {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "expected a board address, got {kind}"
            )));
        }
        let snapshot = workspace_repository::load_board_snapshot(conn, &id)?;
        Ok(snapshot.board)
    }

    /// Reads the full snapshot (board + breadcrumbs + viewport + cards) for a
    /// board by its `myspace://board/<id>` address or a bare board id.
    pub fn read_board(
        conn: &Connection,
        board_address_or_id: &str,
    ) -> Result<BoardSnapshot, WorkspaceError> {
        let id = if let Ok((kind, id)) = parse_address(board_address_or_id) {
            if kind != "board" {
                return Err(WorkspaceError::ConstraintViolation(format!(
                    "expected a board address, got {kind}"
                )));
            }
            id
        } else {
            board_address_or_id.to_string()
        };
        workspace_repository::load_board_snapshot(conn, &id)
    }

    /// Reads a single card by its `myspace://card/<id>` address or a bare card
    /// id. Resolves the card's kind, board, and payload so an agent can follow a
    /// `myspace://card/...` link back to its content (and its `board_id`).
    pub fn read_card(
        conn: &Connection,
        card_address_or_id: &str,
    ) -> Result<CardDto, WorkspaceError> {
        let id = if let Ok((kind, id)) = parse_address(card_address_or_id) {
            if kind != "card" {
                return Err(WorkspaceError::ConstraintViolation(format!(
                    "expected a card address, got {kind}"
                )));
            }
            id
        } else {
            card_address_or_id.to_string()
        };
        workspace_repository::load_card(conn, &id)
    }

    /// Creates a batch of Link Cards (idempotent, durable batch) in a board.
    pub fn create_link_batch(
        conn: &mut Connection,
        input: &CreateLinkBatchInput,
    ) -> Result<CreateLinkBatchResult, WorkspaceError> {
        workspace_repository::create_link_batch(conn, input)
    }

    /// Trashes all cards of an agent batch as one undo unit. Returns the trash
    /// batch id used, or NotFound if the agent batch id is unknown.
    pub fn trash_link_batch(
        conn: &mut Connection,
        agent_batch_id: &str,
    ) -> Result<String, WorkspaceError> {
        let card_ids = workspace_repository::load_batch_card_ids(conn, agent_batch_id)?
            .ok_or_else(|| WorkspaceError::NotFound(agent_batch_id.to_string()))?;
        if card_ids.is_empty() {
            return Err(WorkspaceError::NotFound(agent_batch_id.to_string()));
        }
        let items = card_ids
            .into_iter()
            .map(|id| TrashItem {
                id,
                kind: "embed".to_string(),
            })
            .collect();
        trash_service::trash_selection(conn, &TrashSelectionInput { items })
    }
}
