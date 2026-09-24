//! The concrete application service layer.
//!
//! `WorkspaceService` is the single typed boundary above the `Workspace`
//! mutation funnel. Tauri commands and the MCP stdio adapter both call into
//! it, so business rules (entity addressing, idempotency, batch identity)
//! live in one place (ADR-0005). Every method takes `&Workspace` and is
//! blocking (the MCP stdio loop is synchronous): reads go through
//! `Workspace::read_blocking`, writes go through `Workspace::apply_blocking`
//! and the single mutation funnel (ADR-0011), so every write in the process —
//! Tauri commands, the MCP adapter, startup maintenance — is visible to the
//! same journal hook.

use crate::app::Workspace;
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{
    AddQuickBoardInput, BoardSnapshot, BoardSummary, CardDto, CreateChildBoardInput,
    CreateFilesystemAliasInput, CreateLinkBatchInput, CreateLinkBatchResult, Frame, QuickBoardDto,
    ReorderQuickBoardsInput,
};
use crate::domain::mutation::Mutation;
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
    pub fn create_filesystem_alias(
        ws: &Workspace,
        input: &CreateFilesystemAliasInput,
    ) -> Result<(), WorkspaceError> {
        ws.apply_blocking(Mutation::CreateFilesystemAlias(input.clone()))?
            .into_unit()
    }

    /// Lists all active boards.
    pub fn list_boards(ws: &Workspace) -> Result<Vec<BoardSummary>, WorkspaceError> {
        ws.read_blocking(workspace_repository::list_boards)
    }

    /// Resolves an entity address to a board summary (for `myspace://board/<id>`).
    pub fn resolve_board(ws: &Workspace, address: &str) -> Result<BoardSummary, WorkspaceError> {
        let (kind, id) = parse_address(address)?;
        if kind != "board" {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "expected a board address, got {kind}"
            )));
        }
        ws.read_blocking(|conn| {
            let snapshot = workspace_repository::load_board_snapshot(conn, &id)?;
            Ok(snapshot.board)
        })
    }

    /// Reads the full snapshot (board + breadcrumbs + viewport + cards) for a
    /// board by its `myspace://board/<id>` address or a bare board id.
    pub fn read_board(
        ws: &Workspace,
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
        ws.read_blocking(|conn| workspace_repository::load_board_snapshot(conn, &id))
    }

    /// Reads a single card by its `myspace://card/<id>` address or a bare card
    /// id. Resolves the card's kind, board, and payload so an agent can follow a
    /// `myspace://card/...` link back to its content (and its `board_id`).
    pub fn read_card(ws: &Workspace, card_address_or_id: &str) -> Result<CardDto, WorkspaceError> {
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
        ws.read_blocking(|conn| workspace_repository::load_card(conn, &id))
    }

    /// Creates a child board under `parent_board_id` with the given title,
    /// generating stable UUIDv7 ids for the board and its primary portal.
    /// Returns the new board id.
    pub fn create_board(
        ws: &Workspace,
        parent_board_id: &str,
        title: &str,
    ) -> Result<String, WorkspaceError> {
        let board_id = uuid::Uuid::now_v7().to_string();
        let portal_card_id = uuid::Uuid::now_v7().to_string();
        ws.apply_blocking(Mutation::CreateChildBoard(CreateChildBoardInput {
            parent_board_id: parent_board_id.to_string(),
            board_id: board_id.clone(),
            portal_card_id,
            frame: Frame {
                x: 100.0,
                y: 100.0,
                width: 120.0,
                height: 112.0,
            },
            title: title.to_string(),
        }))?
        .into_unit()?;
        Ok(board_id)
    }

    /// Creates a batch of Link Cards (idempotent, durable batch) in a board.
    pub fn create_link_batch(
        ws: &Workspace,
        input: &CreateLinkBatchInput,
    ) -> Result<CreateLinkBatchResult, WorkspaceError> {
        ws.apply_blocking(Mutation::CreateLinkBatch(input.clone()))?
            .into_link_batch()
    }

    /// Trashes all cards of an agent batch as one undo unit. Returns the trash
    /// batch id used, or NotFound if the agent batch id is unknown.
    pub fn trash_link_batch(
        ws: &Workspace,
        agent_batch_id: &str,
    ) -> Result<String, WorkspaceError> {
        ws.apply_blocking(Mutation::TrashLinkBatch {
            agent_batch_id: agent_batch_id.to_string(),
        })?
        .into_id()
    }

    /// Lists Quick Boards in persisted order.
    pub fn list_quick_boards(ws: &Workspace) -> Result<Vec<QuickBoardDto>, WorkspaceError> {
        ws.read_blocking(workspace_repository::list_quick_boards)
    }

    /// Adds a Quick Board reference idempotently (non-Home, active Board only).
    pub fn add_quick_board(
        ws: &Workspace,
        input: &AddQuickBoardInput,
    ) -> Result<(), WorkspaceError> {
        ws.apply_blocking(Mutation::AddQuickBoard(input.clone()))?
            .into_unit()
    }

    /// Removes a Quick Board reference.
    pub fn remove_quick_board(ws: &Workspace, board_id: &str) -> Result<(), WorkspaceError> {
        ws.apply_blocking(Mutation::RemoveQuickBoard {
            board_id: board_id.to_string(),
        })?
        .into_unit()
    }

    /// Reorders Quick Board references transactionally.
    pub fn reorder_quick_boards(
        ws: &Workspace,
        input: &ReorderQuickBoardsInput,
    ) -> Result<(), WorkspaceError> {
        ws.apply_blocking(Mutation::ReorderQuickBoards(input.clone()))?
            .into_unit()
    }
}
