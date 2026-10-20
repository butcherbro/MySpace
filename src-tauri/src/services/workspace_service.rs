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

use std::io::Read;
use std::path::Path;

use crate::app::Workspace;
use crate::domain::asset_service;
use crate::domain::errors::WorkspaceError;
use crate::domain::image_dimensions::{image_dimensions, HEADER_PROBE_BYTES};
use crate::domain::link_metadata::{MetadataFetcher, ReqwestMetadataFetcher};
use crate::domain::models::{
    AddQuickBoardInput, AssetDto, BoardSnapshot, BoardSummary, CardDto, CreateChildBoardInput,
    CreateFilesystemAliasInput, CreateItemBatchInput, CreateLinkBatchInput, CreateLinkBatchResult,
    Frame, QuickBoardDto, ReorderQuickBoardsInput,
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

/// Image formats an agent may import: the ones the board renders and
/// [`image_dimensions`] can size.
fn sniff_image_mime(header: &[u8]) -> Result<&'static str, WorkspaceError> {
    let mime = if header.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if header.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a") {
        "image/gif"
    } else if header.len() >= 12 && &header[0..4] == b"RIFF" && &header[8..12] == b"WEBP" {
        "image/webp"
    } else {
        return Err(WorkspaceError::ConstraintViolation(
            "unsupported image: expected PNG, JPEG, GIF or WebP".into(),
        ));
    };
    Ok(mime)
}

fn read_header(path: &Path) -> Result<Vec<u8>, WorkspaceError> {
    let file = std::fs::File::open(path).map_err(|e| {
        WorkspaceError::ConstraintViolation(format!("cannot read {}: {e}", path.display()))
    })?;
    let mut header = Vec::new();
    file.take(HEADER_PROBE_BYTES as u64)
        .read_to_end(&mut header)
        .map_err(|e| {
            WorkspaceError::ConstraintViolation(format!("cannot read {}: {e}", path.display()))
        })?;
    Ok(header)
}

fn set_dimensions(asset: &mut AssetDto, header: &[u8]) {
    if let Some((width, height)) = image_dimensions(header) {
        asset.width = Some(width.into());
        asset.height = Some(height.into());
    }
}

fn find_by_content(ws: &Workspace, sha256: &str) -> Result<Option<AssetDto>, WorkspaceError> {
    let sha256 = sha256.to_string();
    ws.read_blocking(move |conn| asset_service::find_asset_by_sha256(conn, &sha256))
}

/// Records a staged asset through the writer, removing the file on failure.
fn record_staged(
    ws: &Workspace,
    staged: asset_service::StagedAsset,
) -> Result<AssetDto, WorkspaceError> {
    match ws.apply_blocking(Mutation::InsertAsset(staged.asset.clone())) {
        Ok(_) => Ok(staged.asset),
        Err(error) => {
            asset_service::discard_staged(&staged);
            Err(error)
        }
    }
}

/// The typed application service.
pub struct WorkspaceService;

impl WorkspaceService {
    pub fn create_filesystem_alias(
        ws: &Workspace,
        input: &CreateFilesystemAliasInput,
    ) -> Result<(), WorkspaceError> {
        ws.apply_blocking(Mutation::CreateFilesystemAlias(input.clone()))?
            .into_card()
            .map(|_| ())
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

    /// Creates a mixed batch of cards (links, notes, images) in one durable,
    /// idempotent operation. Image items must reference stored assets (see
    /// [`Self::import_image_bytes`] / [`Self::import_image_file`]).
    pub fn create_item_batch(
        ws: &Workspace,
        input: &CreateItemBatchInput,
    ) -> Result<CreateLinkBatchResult, WorkspaceError> {
        ws.apply_blocking(Mutation::CreateItemBatch(input.clone()))?
            .into_link_batch()
    }

    /// The recorded result of a batch created under `idempotency_key`, if any.
    pub fn find_batch(
        ws: &Workspace,
        idempotency_key: &str,
    ) -> Result<Option<CreateLinkBatchResult>, WorkspaceError> {
        let key = idempotency_key.to_string();
        ws.read_blocking(move |conn| workspace_repository::find_batch_receipt(conn, &key))
    }

    /// Stores image bytes as a managed asset and returns it. The format is
    /// sniffed from the bytes (PNG, JPEG, GIF, WebP), never trusted from a name
    /// or header. Content-addressed: the same bytes return the existing asset.
    pub fn import_image_bytes(
        ws: &Workspace,
        file_name: &str,
        bytes: &[u8],
    ) -> Result<AssetDto, WorkspaceError> {
        let mime_type = sniff_image_mime(bytes)?;
        if let Some(existing) = find_by_content(ws, &asset_service::sha256_hex(bytes))? {
            return Ok(existing);
        }
        let mut staged = asset_service::stage_asset_bytes(
            &ws.paths().assets_dir(),
            file_name,
            mime_type,
            bytes,
        )?;
        set_dimensions(&mut staged.asset, bytes);
        record_staged(ws, staged)
    }

    /// Copies an image file into the asset store (streamed, never held in
    /// memory) and returns the asset. Same sniffing and dedup as
    /// [`Self::import_image_bytes`].
    pub fn import_image_file(ws: &Workspace, path: &Path) -> Result<AssetDto, WorkspaceError> {
        let header = read_header(path)?;
        let mime_type = sniff_image_mime(&header)?;
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "image".to_string());
        let source = path.to_string_lossy();
        let mut staged = asset_service::stage_image_asset(
            &ws.paths().assets_dir(),
            &uuid::Uuid::now_v7().to_string(),
            &file_name,
            mime_type,
            &source,
        )?;
        if let Some(sha256) = staged.asset.sha256.clone() {
            match find_by_content(ws, &sha256) {
                Ok(Some(existing)) => {
                    asset_service::discard_staged(&staged);
                    return Ok(existing);
                }
                Ok(None) => {}
                Err(error) => {
                    asset_service::discard_staged(&staged);
                    return Err(error);
                }
            }
        }
        set_dimensions(&mut staged.asset, &header);
        record_staged(ws, staged)
    }

    /// Downloads an image from a public http(s) URL (the link-preview fetcher:
    /// private addresses blocked, size-capped) and stores it as an asset.
    pub fn import_image_url(ws: &Workspace, url: &str) -> Result<AssetDto, WorkspaceError> {
        let fetcher = ReqwestMetadataFetcher::new()?;
        let response = fetcher
            .fetch_image(url)
            .map_err(|e| WorkspaceError::ConstraintViolation(format!("cannot fetch {url}: {e}")))?;
        let file_name = url::Url::parse(&response.final_url)
            .ok()
            .and_then(|u| {
                u.path_segments()
                    .and_then(|mut s| s.next_back().map(str::to_string))
            })
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "image".to_string());
        Self::import_image_bytes(ws, &file_name, &response.bytes)
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
