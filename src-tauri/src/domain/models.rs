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

impl Frame {
    /// Card width bounds (formerly `CHECK(width >= 120 AND width <= 1600)`).
    pub const MIN_WIDTH: f64 = 120.0;
    pub const MAX_WIDTH: f64 = 1600.0;
    /// Card height bounds (formerly `CHECK(height >= 48 AND height <= 10000)`).
    pub const MIN_HEIGHT: f64 = 48.0;
    pub const MAX_HEIGHT: f64 = 10000.0;

    /// The frame invariants SQLite used to enforce with CHECK constraints on
    /// `cards` (dropped in migration 0021): width in 120..=1600, height in
    /// 48..=10000, finite x/y. Called by every repository function that
    /// writes a whole frame.
    pub fn validate(&self) -> Result<(), crate::domain::errors::WorkspaceError> {
        use crate::domain::errors::WorkspaceError;
        if !self.x.is_finite() || !self.y.is_finite() {
            return Err(WorkspaceError::ConstraintViolation(
                "card position must be finite".into(),
            ));
        }
        // `contains` is false for NaN, so a NaN size is rejected here too.
        if !(Self::MIN_WIDTH..=Self::MAX_WIDTH).contains(&self.width) {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "card width must be between {} and {}",
                Self::MIN_WIDTH,
                Self::MAX_WIDTH
            )));
        }
        if !(Self::MIN_HEIGHT..=Self::MAX_HEIGHT).contains(&self.height) {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "card height must be between {} and {}",
                Self::MIN_HEIGHT,
                Self::MAX_HEIGHT
            )));
        }
        Ok(())
    }
}

/// Board identity within a snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardSummary {
    pub id: String,
    pub title: String,
    pub parent_board_id: Option<String>,
    pub revision: i64,
    /// Visual identity: color/symbol fallback or a cover image.
    pub color_token: String,
    pub symbol: Option<String>,
    pub cover_asset: Option<AssetDto>,
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
    pub board_revision: i64,
    pub title: String,
    pub color_token: String,
    pub symbol: Option<String>,
    pub child_board_count: i64,
    pub child_card_count: i64,
    /// An optional cover image that replaces the color/symbol tile.
    pub cover_asset: Option<AssetDto>,
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
    /// Semantic background-color preset id (`default`, `yellow`, …).
    pub color_token: String,
    /// True when the stored `document_json` is not valid JSON (P1.7): the JSON field
    /// then carries an empty doc and the plain text is the only recoverable
    /// content. Writes to a corrupt card must set `acknowledgeCorrupt`.
    #[serde(default)]
    pub corrupt: bool,
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
    /// True when the stored `caption_json` is not valid JSON (P1.7): the JSON field
    /// then carries an empty doc and the plain text is the only recoverable
    /// content. Writes to a corrupt card must set `acknowledgeCorrupt`.
    #[serde(default)]
    pub corrupt: bool,
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
    /// `'user'` = author's comment (authoritative), `'site'` = fetched fallback,
    /// `None` = no description. Renders a user comment as its own note.
    pub description_origin: Option<String>,
    pub favicon_asset: Option<AssetDto>,
    pub preview_asset: Option<AssetDto>,
    pub preview_origin: Option<String>,
    pub metadata_status: String,
    pub metadata_error: Option<String>,
    /// True when the stored `description_json` is not valid JSON (P1.7): the JSON field
    /// then carries an empty doc and the plain text is the only recoverable
    /// content. Writes to a corrupt card must set `acknowledgeCorrupt`.
    #[serde(default)]
    pub corrupt: bool,
}

/// A durable shortcut to an external filesystem item. The stored bookmark
/// bytes remain server-side; this projection intentionally exposes only display identity.
///
/// Device scope (ADR-0012): the card is board content and syncs; the locator
/// that makes it open belongs to one device. `local` says whether THIS device
/// holds a locator for it; `path_hint` stays as the origin device wrote it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemAliasDto {
    pub id: String,
    pub board_id: String,
    pub frame: Frame,
    pub z_index: i64,
    pub revision: i64,
    pub target_kind: String,
    pub path_hint: String,
    pub display_name: String,
    /// The device that created the shortcut (and wrote `path_hint`).
    pub origin_device_id: String,
    /// Its human name from `known_devices`, when this device knows it.
    pub origin_device_name: Option<String>,
    /// True when this device holds a locator for the card.
    pub local: bool,
}

/// The target board's identity, as seen through a shortcut. `None` when the
/// target board no longer exists or is itself trashed (an old/broken shortcut,
/// todo.md №17) — the frontend renders a broken tile instead of crashing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardShortcutTarget {
    pub id: String,
    pub board_revision: i64,
    pub title: String,
    pub color_token: String,
    pub symbol: Option<String>,
    pub cover_asset: Option<AssetDto>,
}

/// A board shortcut card: an alias that points at a board without owning it
/// (ownership stays with `board_portal_cards`). Identity (cover/color/symbol/
/// title) is read live through `target_board_id` — never copied — so a rename
/// of the target board is visible immediately.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardShortcutDto {
    pub id: String,
    pub board_id: String,
    pub frame: Frame,
    pub z_index: i64,
    pub revision: i64,
    pub target_board_id: String,
    pub target: Option<BoardShortcutTarget>,
}

/// Input for creating a board shortcut (todo.md №17): "Create shortcut" on a
/// Board Portal or on another shortcut targeting the same board. A shortcut
/// never targets another shortcut — only a real board id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBoardShortcutInput {
    pub id: String,
    pub board_id: String,
    pub frame: Frame,
    pub z_index: i64,
    pub target_board_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntryDto {
    pub name: String,
    pub kind: String,
    pub size_bytes: Option<i64>,
    pub child_count: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderPreviewStatus {
    Ready,
    Empty,
    Missing,
    PermissionLost,
    IoError,
    /// The shortcut has no locator on this device (created on another one,
    /// ADR-0012). Returned without touching the filesystem.
    ForeignDevice,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPreviewDto {
    pub status: FolderPreviewStatus,
    pub entries: Vec<FolderEntryDto>,
    pub has_more: bool,
    pub display_name: String,
    pub path_hint: String,
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
    /// Lowercase hex SHA-256 of the stored file (ADR-0011 §4 blob identity).
    /// `None` for rows created before migration 0020 that the background
    /// `maintenance.hash_assets` job has not reached yet. `#[serde(default)]`
    /// keeps older JSON (without the field) deserialisable.
    #[serde(default)]
    pub sha256: Option<String>,
}

/// A File Card: a text-like file copied into the managed asset store with a
/// bounded inline preview for display.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCardDto {
    pub id: String,
    pub board_id: String,
    pub frame: Frame,
    pub z_index: i64,
    pub revision: i64,
    pub asset: AssetDto,
    pub preview_text: String,
    /// Generated thumbnail (PDF/office/HTML) when available.
    pub preview_asset: Option<AssetDto>,
}

/// Input for creating a File Card from a dropped text-like file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFileCardInput {
    pub id: String,
    pub board_id: String,
    pub frame: Frame,
    pub z_index: i64,
    pub source_path: String,
    pub mime_type: String,
    pub file_name: String,
}

/// The card kinds, tagged for the frontend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CardDto {
    Note(NoteCardDto),
    #[serde(rename = "board_portal")]
    BoardPortal(BoardPortalDto),
    Image(ImageCardDto),
    Embed(Box<EmbedCardDto>),
    #[serde(rename = "filesystem_alias")]
    FilesystemAlias(FilesystemAliasDto),
    #[serde(rename = "file")]
    File(FileCardDto),
    #[serde(rename = "board_shortcut")]
    BoardShortcut(BoardShortcutDto),
}

impl CardDto {
    /// The card's stable id.
    pub fn id(&self) -> &str {
        match self {
            CardDto::Note(n) => &n.id,
            CardDto::BoardPortal(p) => &p.id,
            CardDto::Image(i) => &i.id,
            CardDto::Embed(e) => &e.id,
            CardDto::FilesystemAlias(a) => &a.id,
            CardDto::File(f) => &f.id,
            CardDto::BoardShortcut(s) => &s.id,
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
    /// Cards in this board's Unsorted panel (not yet placed on the canvas).
    pub unsorted_cards: Vec<CardDto>,
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
}

/// Input for updating a note's content and bumping its revision. The stored
/// `plain_text` is derived by the backend (`domain::plain_text`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNoteInput {
    pub id: String,
    pub expected_revision: i64,
    pub document_json: Value,
    /// Required (true) to overwrite a stored document that is corrupt
    /// (P1.7); without it such a write is rejected.
    #[serde(default)]
    pub acknowledge_corrupt: bool,
}

/// Receipt of a card-level write: the revision the row now has, read back
/// inside the write transaction (P1.5). The frontend adopts it instead of
/// computing `revision + 1`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardReceipt {
    pub id: String,
    pub revision: i64,
}

/// Receipt of a text write (note body, image caption, link description): the
/// stored revision plus the backend-derived plain text, so the UI shows
/// exactly what was stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextReceipt {
    pub id: String,
    pub revision: i64,
    pub plain_text: String,
}

/// Receipt of a multi-card write: one entry per card, in input order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardsReceipt {
    pub cards: Vec<CardReceipt>,
}

/// Receipt of a viewport save: the board revision now stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewportReceipt {
    pub revision: i64,
}

/// Input for setting a note card's background color preset. Does not bump the
/// card revision (color is orthogonal to text content and must not conflict
/// with text autosave).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetNoteColorInput {
    pub id: String,
    pub color_token: String,
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

/// Input for atomically reparenting a Board (and its unique portal card) to a
/// new parent board. The backend discovers the portal via
/// `board_portal_cards.target_board_id`; the frontend supplies only stable IDs
/// and revisions plus the destination frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveBoardInput {
    pub board_id: String,
    pub expected_board_revision: i64,
    pub expected_portal_revision: i64,
    pub target_parent_board_id: String,
    pub frame: Frame,
}

/// One leaf card of a mixed-selection move, pinned to the revision it was read at.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveSelectionCard {
    pub id: String,
    pub expected_revision: i64,
}

/// One Board Portal of a mixed-selection move. The backend resolves the portal
/// card from `board_id` itself, exactly like `move_board`, and picks the
/// destination slot — the frontend supplies neither a portal id nor a frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveSelectionBoard {
    pub board_id: String,
    pub expected_board_revision: i64,
    pub expected_portal_revision: i64,
}

/// Where the leaf cards land in the destination board. Only `Unsorted` exists
/// today: a single frame would be ambiguous for a group.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectionLeafPlacement {
    Unsorted,
}

/// Input for the one atomic mixed-selection move (ADR-0007). Either every listed
/// card and board moves, or nothing does.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveSelectionToBoardInput {
    /// Replay guard: the same key must return the original receipt, and the same
    /// key with a different payload must be rejected.
    pub idempotency_key: String,
    pub target_board_id: String,
    pub cards: Vec<MoveSelectionCard>,
    pub boards: Vec<MoveSelectionBoard>,
    pub leaf_placement: SelectionLeafPlacement,
}

/// One moved leaf, carrying everything the atomic undo needs to put it back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovedCardReceipt {
    pub id: String,
    pub previous_board_id: String,
    pub previous_unsorted: bool,
    pub previous_frame: Frame,
    pub before_revision: i64,
    pub after_revision: i64,
}

/// One reparented board, carrying both portal positions and both revisions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovedBoardReceipt {
    pub board_id: String,
    pub portal_card_id: String,
    pub previous_parent_board_id: String,
    pub previous_portal_frame: Frame,
    pub destination_portal_frame: Frame,
    pub before_board_revision: i64,
    pub after_board_revision: i64,
    pub before_portal_revision: i64,
    pub after_portal_revision: i64,
}

/// The receipt of one mixed-selection move. It is also the undo's input, so the
/// frontend mirrors the backend instead of assuming `revision + 1`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveSelectionToBoardReceipt {
    pub operation_id: String,
    pub target_board_id: String,
    pub cards: Vec<MovedCardReceipt>,
    pub boards: Vec<MovedBoardReceipt>,
}

/// Input for duplicating a Board Portal's whole subtree (todo.md №16): a new
/// board + portal are created as a recursive copy of `source_board_id`. Only the
/// root portal/board ids are frontend-generated (stable for optimistic undo);
/// every copied descendant id is generated by the backend inside the one
/// transaction — documented as an intentional exception to "frontend generates
/// every id" in `docs/decisions/0010-duplicate-board.md`, because the set of
/// descendants to copy is discovered only inside the transaction itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateBoardInput {
    pub source_board_id: String,
    /// The board the new portal is placed on (may equal the source's own
    /// parent, for the "Duplicate" menu action, or any board under the cursor
    /// for copy/paste).
    pub target_board_id: String,
    pub new_board_id: String,
    pub new_portal_card_id: String,
    pub frame: Frame,
}

/// What `duplicate_board` hands back: the new board's id plus the new portal's
/// full projection, so the frontend can place it on the canvas without a
/// second round trip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateBoardReceipt {
    pub new_board_id: String,
    pub portal: BoardPortalDto,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFilesystemAliasInput {
    pub id: String,
    pub board_id: String,
    pub frame: Frame,
    pub z_index: i64,
    pub target_kind: String,
    /// This device's locator for the new shortcut; stored in
    /// `filesystem_alias_locators` under the current device id, never in the
    /// synced `filesystem_aliases` row.
    #[serde(skip_serializing, skip_deserializing, default)]
    pub locator_blob: Vec<u8>,
    pub path_hint: String,
    pub display_name: String,
}

/// Input for updating an image card's caption, bumping its revision with an
/// optimistic guard (mirrors `UpdateNoteInput`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateImageCaptionInput {
    pub id: String,
    pub expected_revision: i64,
    pub caption_json: Value,
    /// Required (true) to overwrite a stored document that is corrupt
    /// (P1.7); without it such a write is rejected.
    #[serde(default)]
    pub acknowledge_corrupt: bool,
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
}

/// Input for updating an embed (Link) card's description body, bumping its
/// revision with an optimistic guard (mirrors `UpdateNoteInput`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEmbedDescriptionInput {
    pub id: String,
    pub expected_revision: i64,
    pub description_json: Value,
    /// Required (true) to overwrite a stored document that is corrupt
    /// (P1.7); without it such a write is rejected.
    #[serde(default)]
    pub acknowledge_corrupt: bool,
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
    /// The current user-authored description, if any (guard against overwrite).
    pub description_plain_text: String,
    /// `'user'` if the description is an authoritative user comment.
    pub description_origin: Option<String>,
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
    pub description_origin: Option<String>,
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
    /// Optional destination frame. When omitted the card lands at the board
    /// origin (legacy behavior); when present the card is placed exactly there
    /// (needed for cross-board drag-and-drop).
    #[serde(default)]
    pub frame: Option<Frame>,
}

/// One card to move into a Board's Unsorted panel (batch item).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveCardToUnsortedItem {
    pub id: String,
    pub expected_revision: i64,
}

/// Atomically moves a group of cards into a Board's Unsorted panel. One batch =
/// one undo unit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveCardsToUnsortedInput {
    pub target_board_id: String,
    pub cards: Vec<MoveCardToUnsortedItem>,
}

/// Places one Unsorted card onto the board at an exact frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceUnsortedCardInput {
    pub id: String,
    pub expected_revision: i64,
    pub frame: Frame,
}

/// A single item to trash: a leaf card by card id, or a board (portal) by its
/// target board id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: String,
    /// One of `note` | `image` | `embed` | `filesystem_alias` | `board_portal`.
    pub kind: String,
}

/// Input for atomically trashing a mixed selection (leaf cards + boards) in one
/// transaction under a single trash batch id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashSelectionInput {
    pub items: Vec<TrashItem>,
}

/// A single representative top-level item in a Trash batch. A Board or leaf
/// card that was directly trashed (not merely a descendant swept up with a
/// parent Board) is shown; descendants are summarized in the batch counts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntryDto {
    pub id: String,
    /// One of `note` | `image` | `embed` | `filesystem_alias` | `board`.
    pub kind: String,
    pub title: String,
    /// Thumbnail source: the image/preview/cover asset, when one exists.
    pub thumbnail_asset: Option<AssetDto>,
    /// Board identity fallback (color/symbol) when there is no thumbnail.
    pub color_token: Option<String>,
    pub symbol: Option<String>,
}

/// One recoverable Trash batch: a single atomic delete operation that may span
/// a mixed selection or an entire Board subtree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashBatchDto {
    pub batch_id: String,
    pub deleted_at: i64,
    pub items: Vec<TrashEntryDto>,
    pub board_count: i64,
    pub card_count: i64,
}

/// The Trash read model, newest batch first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashSummaryDto {
    pub batches: Vec<TrashBatchDto>,
    pub batch_count: i64,
    pub board_count: i64,
    pub card_count: i64,
}

/// Result of permanently emptying the Trash.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmptyTrashResult {
    pub board_count: i64,
    pub card_count: i64,
    pub orphan_asset_count: i64,
}

/// A single workspace search result. `kind` is the user-facing kind (`board`,
/// `note`, or `link` — the `embed` card is reported as `link`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultDto {
    pub entity_id: String,
    pub kind: String,
    pub title: String,
    /// A bounded match-context snippet; `None` when the match is in the title.
    pub excerpt: Option<String>,
    pub board_id: String,
    /// The root-first ancestor trail (`Home / … / board_id`).
    pub board_trail: Vec<Breadcrumb>,
    /// The board's visual identity, so results can be grouped and shown with the
    /// same cover/icon/acronym fallback as everywhere else in the UI.
    pub board_color_token: String,
    pub board_symbol: Option<String>,
    pub board_cover_asset: Option<AssetDto>,
    /// Thumbnail for the matched entity itself: image asset, link preview/
    /// favicon, or board cover.
    pub thumbnail_asset: Option<AssetDto>,
    /// Entity creation time (unix millis) for the relative-time label.
    pub created_at: i64,
}

/// A single Link Card to create in a batch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkBatchItem {
    /// Stable client-supplied card id (UUIDv7). Enables idempotent replay.
    pub id: String,
    pub source_url: String,
    pub title: String,
    /// Optional user comment shown under the preview. Authoritative: enrichment
    /// never overwrites a non-empty user description.
    #[serde(default)]
    pub description: String,
}

/// Input for creating a batch of Link Cards in one durable operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLinkBatchInput {
    pub idempotency_key: String,
    pub board_id: String,
    pub links: Vec<LinkBatchItem>,
}

/// Result of a batch Link Card create: the created card ids plus a durable batch
/// id that represents the operation as one undo/trash unit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLinkBatchResult {
    pub batch_id: String,
    pub card_ids: Vec<String>,
}

/// A Quick Board reference: a stable, ordered, workspace-scoped pointer to a
/// (non-Home) Board. Not a tab, portal, copy, or move.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickBoardDto {
    pub board_id: String,
    pub title: String,
    pub color_token: String,
    pub symbol: Option<String>,
    pub sort_order: i64,
    /// Optional cover image, so a pinned chip mirrors the portal tile.
    pub cover_asset: Option<AssetDto>,
}

/// Input for adding a Quick Board reference. Idempotent: adding an already-pinned
/// board updates nothing and succeeds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddQuickBoardInput {
    pub board_id: String,
}

/// Input for reordering Quick Board references. `board_ids` is the full new
/// order (all currently-pinned boards), applied transactionally.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderQuickBoardsInput {
    pub board_ids: Vec<String>,
}
