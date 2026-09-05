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

/// The Link Card (link preview) surface. The user-facing "Link Card" is the
/// existing domain `embed` kind. Fields mirror docs/specs/link-card-and-clipboard.md.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedCardDto {
    pub id: String,
    pub board_id: String,
    pub frame: Frame,
    pub z_index: i64,
    pub revision: i64,
    pub source_url: String,
    pub display_url: String,
    pub site_name: Option<String>,
    pub title: String,
    pub provider: Option<String>,
    pub description_json: Value,
    pub description_plain_text: String,
    pub favicon_asset: Option<AssetDto>,
    pub preview_asset: Option<AssetDto>,
    pub preview_origin: Option<String>,
    pub metadata_status: String,
    pub metadata_error: Option<String>,
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
    /// Path relative to the asset root, used to build the asset URL.
    pub file_path: String,
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

/// Input for updating an image card's caption, bumping its revision with an
/// optimistic guard (mirrors `UpdateNoteInput`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateImageCaptionInput {
    pub id: String,
    pub expected_revision: i64,
    pub caption_json: Value,
    pub caption_plain_text: String,
}

/// Input for converting a Note into an Embed (Link) Card transactionally. The
/// source URL is authoritative; title/description start as a network-free
/// fallback and are enriched later by metadata acquisition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertNoteToEmbedInput {
    pub id: String,
    pub expected_revision: i64,
    pub source_url: String,
    pub display_url: String,
    pub title: String,
    pub description_json: Value,
    pub description_plain_text: String,
}

/// Input for updating an embed (Link) card's description body, bumping its
/// revision with an optimistic guard (mirrors `UpdateNoteInput`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEmbedDescriptionInput {
    pub id: String,
    pub expected_revision: i64,
    pub description_json: Value,
    pub description_plain_text: String,
}

/// Input for asynchronously enriching a pending embed (Link) card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichEmbedMetadataInput {
    pub id: String,
    pub expected_revision: i64,
}

/// Minimal embed projection read before metadata network I/O.
#[derive(Debug, Clone, PartialEq)]
pub struct EmbedForMetadata {
    pub id: String,
    pub revision: i64,
    pub source_url: String,
    pub display_url: String,
    pub title: String,
    pub preview_origin: Option<String>,
}

/// Transactional metadata update for an embed (Link) card.
#[derive(Debug, Clone, PartialEq)]
pub struct ApplyEmbedMetadataInput {
    pub id: String,
    pub expected_revision: i64,
    pub display_url: String,
    pub site_name: Option<String>,
    pub title: String,
    pub provider: Option<String>,
    pub description_json: Value,
    pub description_plain_text: String,
    pub preview_asset_id: Option<String>,
    pub favicon_asset_id: Option<String>,
    pub metadata_status: String,
    pub metadata_error: Option<String>,
}

/// Input for moving a card to a different board (e.g. dropping a note onto a
/// board portal), bumping its revision with an optimistic guard.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveCardToBoardInput {
    pub id: String,
    pub expected_revision: i64,
    pub target_board_id: String,
}

/// A single item to trash: a leaf card by card id, or a board (portal) by its
/// target board id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: String,
    /// One of `note` | `image` | `embed` | `board_portal`.
    pub kind: String,
}

/// Input for atomically trashing a mixed selection (leaf cards + boards) in one
/// transaction under a single trash batch id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashSelectionInput {
    pub items: Vec<TrashItem>,
}
