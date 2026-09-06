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
    AddQuickBoardInput, BoardSnapshot, BoardSummary, CardDto, CreateLinkBatchInput,
    CreateLinkBatchResult, QuickBoardDto, ReorderQuickBoardsInput, TrashItem, TrashSelectionInput,
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

    /// Creates a child board under `parent_board_id` with the given title,
    /// generating stable UUIDv7 ids for the board and its primary portal.
    /// Returns the new board id.
    pub fn create_board(
        conn: &mut Connection,
        parent_board_id: &str,
        title: &str,
    ) -> Result<String, WorkspaceError> {
        let board_id = uuid::Uuid::now_v7().to_string();
        let portal_card_id = uuid::Uuid::now_v7().to_string();
        crate::domain::board_service::create_child_board(
            conn,
            &crate::domain::models::CreateChildBoardInput {
                parent_board_id: parent_board_id.to_string(),
                board_id: board_id.clone(),
                portal_card_id,
                frame: crate::domain::models::Frame {
                    x: 100.0,
                    y: 100.0,
                    width: 120.0,
                    height: 112.0,
                },
                title: title.to_string(),
            },
        )?;
        Ok(board_id)
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

    /// Lists Quick Boards in persisted order.
    pub fn list_quick_boards(conn: &Connection) -> Result<Vec<QuickBoardDto>, WorkspaceError> {
        workspace_repository::list_quick_boards(conn)
    }

    /// Adds a Quick Board reference idempotently (non-Home, active Board only).
    pub fn add_quick_board(
        conn: &mut Connection,
        input: &AddQuickBoardInput,
    ) -> Result<(), WorkspaceError> {
        workspace_repository::add_quick_board(conn, input)
    }

    /// Removes a Quick Board reference.
    pub fn remove_quick_board(conn: &mut Connection, board_id: &str) -> Result<(), WorkspaceError> {
        workspace_repository::remove_quick_board(conn, board_id)
    }

    /// Reorders Quick Board references transactionally.
    pub fn reorder_quick_boards(
        conn: &mut Connection,
        input: &ReorderQuickBoardsInput,
    ) -> Result<(), WorkspaceError> {
        workspace_repository::reorder_quick_boards(conn, input)
    }
}
