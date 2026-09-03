//! Domain DTOs exchanged across the IPC boundary.
//!
//! These mirror the `BoardSnapshot` contract from the V1 plan. All fields are
//! serialized as camelCase so the TypeScript frontend can consume them
//! directly.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A card's placement rectangle on a board canvas.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Board identity within a snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardSummary {
    pub id: String,
    pub title: String,
    pub parent_board_id: Option<String>,
    pub revision: i64,
}

/// A breadcrumb ancestor entry (Home ... current board).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Breadcrumb {
    pub id: String,
    pub title: String,
}

/// The persisted viewport for a board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
    pub revision: i64,
}

/// Metadata for a child board referenced by a portal card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalTarget {
    pub id: String,
    pub title: String,
    pub color_token: String,
    pub symbol: Option<String>,
    pub child_board_count: i64,
    pub child_card_count: i64,
}

/// A note card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteCardDto {
    pub id: String,
    pub board_id: String,
    pub frame: Frame,
    pub z_index: i64,
    pub revision: i64,
    pub document_json: Value,
    pub plain_text: String,
}

/// A board portal card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardPortalDto {
    pub id: String,
    pub board_id: String,
    pub frame: Frame,
    pub z_index: i64,
    pub revision: i64,
    pub target: PortalTarget,
}

/// An image card: a static image plus an editable rich-text caption.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCardDto {
    pub id: String,
    pub board_id: String,
    pub frame: Frame,
    pub z_index: i64,
    pub revision: i64,
    pub asset: AssetDto,
    pub caption_json: Value,
    pub caption_plain_text: String,
}

/// An embed card: a URL with an optional preview image.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedCardDto {
    pub id: String,
    pub board_id: String,
    pub frame: Frame,
    pub z_index: i64,
    pub revision: i64,
    pub url: String,
    pub title: Option<String>,
    pub provider: Option<String>,
    pub asset: Option<AssetDto>,
}

/// Metadata for a stored file asset (image / preview thumbnail).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDto {
    pub id: String,
    pub file_name: String,
    pub mime_type: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub size_bytes: i64,
}

/// The card kinds, tagged for the frontend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CardDto {
    Note(NoteCardDto),
    #[serde(rename = "board_portal")]
    BoardPortal(BoardPortalDto),
    Image(ImageCardDto),
    Embed(EmbedCardDto),
}

impl CardDto {
    /// The card's stable id.
    pub fn id(&self) -> &str {
        match self {
            CardDto::Note(n) => &n.id,
            CardDto::BoardPortal(p) => &p.id,
            CardDto::Image(i) => &i.id,
            CardDto::Embed(e) => &e.id,
        }
    }
}

/// A complete, self-contained projection of one board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardSnapshot {
    pub board: BoardSummary,
    pub breadcrumbs: Vec<Breadcrumb>,
    pub viewport: Viewport,
    pub cards: Vec<CardDto>,
}

/// Input for creating a note card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNoteInput {
    pub id: String,
    pub board_id: String,
    pub frame: Frame,
    pub z_index: i64,
    pub document_json: Value,
    pub plain_text: String,
}

/// Input for updating a note's content and bumping its revision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNoteInput {
    pub id: String,
    pub expected_revision: i64,
    pub document_json: Value,
    pub plain_text: String,
}

/// Input for moving/resizing a card (note or portal) and bumping its revision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCardFrameInput {
    pub id: String,
    pub expected_revision: i64,
    pub frame: Frame,
}

/// Input for persisting a board's viewport.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateViewportInput {
    pub board_id: String,
    pub expected_revision: i64,
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

/// A single card move within a transactional batch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveCardItem {
    pub id: String,
    pub expected_revision: i64,
    pub frame: Frame,
}

/// A transactional multi-card move (one gesture = one transaction/undo entry).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveCardsInput {
    pub cards: Vec<MoveCardItem>,
}

/// Input for creating a child board + its primary portal card atomically. All
/// IDs are generated by the frontend before persistence (stable for optimistic
/// UI and idempotent replay).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChildBoardInput {
    pub parent_board_id: String,
    pub board_id: String,
    pub portal_card_id: String,
    pub frame: Frame,
    pub title: String,
}

/// Input for importing a file into the asset store. The file bytes are read
/// from `source_path` (a Tauri-provided absolute path from a picker/drop) and
/// copied into the app's asset dir; metadata is returned.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAssetInput {
    pub id: String,
    pub source_path: String,
    pub file_name: String,
    pub mime_type: String,
}

/// Input for creating an image card referencing an already-imported asset.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateImageCardInput {
    pub id: String,
    pub board_id: String,
    pub frame: Frame,
    pub z_index: i64,
    pub asset_id: String,
    pub caption_json: Value,
    pub caption_plain_text: String,
}
