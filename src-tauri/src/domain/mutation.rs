//! The mutation vocabulary: every write the application can perform, as data.
//!
//! `Mutation` is the single entry point for writes (ADR-0011 "single mutation
//! funnel"). Tauri commands, the MCP adapter and startup maintenance construct
//! a variant and hand it to `Workspace::apply`; the writer thread calls
//! [`Mutation::execute`], which dispatches to the existing domain/repository
//! function. Nothing outside this module and the writer thread calls a
//! mutating repository function.
//!
//! Why an enum and not closures: the device-sync journal (ADR-0011, S1) records
//! each applied mutation as `(op, payload)`. The variant name is the `op`; the
//! carried input is the payload. When the journal lands, this enum gains
//! `Serialize`/`Deserialize` and `execute` gains a journal append inside the same
//! transaction. Inputs that cannot be serialised today (`StagedAsset`, the
//! enrichment input) are the ones S1 has to make serialisable, so keeping them
//! visible here is deliberate.
//!
//! Adding a mutating command = adding a variant here + one match arm in
//! `execute`, one `name` arm and one `is_local_only` arm. Nothing else.
//!
//! Local-only data (ADR-0011, ADR-0012). Some writes only touch state that
//! belongs to this installation and must never leave it: the viewport, the
//! device identity, and the per-device filesystem shortcut locators. They
//! still go through this funnel (one writer, one telemetry path), but
//! [`Mutation::is_local_only`] returns `true` for them and the journal (S1)
//! skips them, and [`LOCAL_ONLY_TABLES`] lists the tables the journal and any
//! row-level exchange must never read or write. The two are checked against
//! each other by a test: a local-only mutation writes only local-only tables.

use rusqlite::Connection;

use crate::app::WorkspacePaths;
use crate::domain::asset_service::{self, StagedAsset};
use crate::domain::device::DeviceIdentity;
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{
    AddQuickBoardInput, AssetDto, CardDto, CardReceipt, CardsReceipt, ConvertNoteToEmbedInput,
    CreateBoardShortcutInput, CreateChildBoardInput, CreateFileCardInput,
    CreateFilesystemAliasInput, CreateImageCardInput, CreateLinkBatchInput, CreateLinkBatchResult,
    CreateNoteInput, DuplicateBoardInput, DuplicateBoardReceipt, EmbedCardDto, EmptyTrashResult,
    MoveBoardInput, MoveCardToBoardInput, MoveCardsInput, MoveCardsToUnsortedInput,
    MoveSelectionToBoardInput, MoveSelectionToBoardReceipt, PlaceUnsortedCardInput,
    ReorderQuickBoardsInput, SetNoteColorInput, TextReceipt, TrashSelectionInput,
    UpdateCardFrameInput, UpdateEmbedDescriptionInput, UpdateImageCaptionInput, UpdateNoteInput,
    UpdateViewportInput, ViewportReceipt,
};
use crate::domain::{board_service, duplicate_board, link_metadata, move_selection, trash_service};
use crate::repositories::devices;
use crate::repositories::workspace_repository as repo;

/// Tables that hold device-local state and are never synced: not journaled,
/// not exchanged, not overwritten by a replay (ADR-0011 "what the data layer
/// must prepare", ADR-0012 §1–2).
///
/// - `local_meta`: this installation's `device_id` / `device_name`.
/// - `filesystem_alias_locators`: platform locators (macOS bookmarks,
///   `path:v1:` blobs) per (card, device); meaningless on any other device.
/// - `board_view_states`: the viewport, own-device UI state.
/// - `known_devices`: this device's directory of device names. Other devices'
///   names reach it through the sync handshake (each peer announces its
///   `local_meta` identity), not through journaled rows, so a rename is a
///   local write on every device and no two devices ever fight over a row.
///
/// Derived tables (`search_index`, `search_index_keys`, `boards.change_seq`)
/// are rebuilt by triggers on each replica and are not listed: the journal
/// never carries them either.
pub const LOCAL_ONLY_TABLES: &[&str] = &[
    "local_meta",
    "filesystem_alias_locators",
    "board_view_states",
    "known_devices",
];

/// One write, as data. See the module docs.
pub enum Mutation {
    // ---- cards ------------------------------------------------------------
    CreateNote(CreateNoteInput),
    CreateImageCard(CreateImageCardInput),
    CreateBoardShortcut(CreateBoardShortcutInput),
    UpdateNote(UpdateNoteInput),
    SetNoteColor(SetNoteColorInput),
    UpdateImageCaption(UpdateImageCaptionInput),
    MoveCard(UpdateCardFrameInput),
    MoveCards(MoveCardsInput),
    MoveCardToBoard(MoveCardToBoardInput),
    MoveCardsToBoardUnsorted(MoveCardsToUnsortedInput),
    PlaceUnsortedCard(PlaceUnsortedCardInput),
    ConvertNoteToEmbed(ConvertNoteToEmbedInput),
    UpdateEmbedDescription(UpdateEmbedDescriptionInput),
    MoveSelectionToBoard(MoveSelectionToBoardInput),
    UndoMoveSelection(MoveSelectionToBoardReceipt),

    // ---- boards -----------------------------------------------------------
    SaveViewport(UpdateViewportInput),
    CreateChildBoard(CreateChildBoardInput),
    RenameBoard {
        board_id: String,
        title: String,
    },
    MoveBoard(MoveBoardInput),
    /// `asset_id: None` removes the cover.
    SetBoardCover {
        board_id: String,
        asset_id: Option<String>,
    },
    DuplicateBoard(DuplicateBoardInput),

    // ---- trash ------------------------------------------------------------
    TrashNote {
        card_id: String,
    },
    TrashBoard {
        board_id: String,
    },
    TrashSelection(TrashSelectionInput),
    RestoreTrashBatch {
        batch_id: String,
    },
    /// Takes the mandatory pre-empty backup snapshot on the writer thread,
    /// then hard-deletes. `confirmation` must be the literal `EMPTY`.
    EmptyTrash {
        confirmation: String,
    },

    // ---- quick boards -----------------------------------------------------
    AddQuickBoard(AddQuickBoardInput),
    RemoveQuickBoard {
        board_id: String,
    },
    ReorderQuickBoards(ReorderQuickBoardsInput),

    // ---- assets and filesystem cards -------------------------------------
    /// Records an asset whose file was already staged by the caller. On error
    /// the caller discards the staged file.
    InsertAsset(AssetDto),
    /// Creates the card with this device as origin and this device's
    /// locator. Shared: the journal payload is the card + detail row (the
    /// kind codec never includes locator bytes); the locator row stays here.
    CreateFilesystemAlias(CreateFilesystemAliasInput),
    /// Renews this device's stale bookmark; on the origin device also the
    /// synced display metadata. Shared for the same reason as
    /// `CreateFilesystemAlias`.
    RefreshFilesystemAliasLocator {
        card_id: String,
        locator_blob: Vec<u8>,
        path_hint: String,
        display_name: String,
    },
    /// Asset rows + card rows for a dropped file, in one transaction. All file
    /// I/O (copy, preview, Quick Look) happened before this was queued. Boxed:
    /// it is by far the largest payload and would otherwise size every
    /// `Mutation` that crosses the writer queue.
    CommitFileCard(Box<CommitFileCard>),
    /// "Point to a folder on this computer…" (ADR-0012 §5): stores this
    /// device's locator for a shortcut. LOCAL-ONLY (`is_local_only`).
    SetFilesystemAliasLocalTarget {
        card_id: String,
        locator_blob: Vec<u8>,
    },

    // ---- device (local-only) ---------------------------------------------
    /// Renames this device. LOCAL-ONLY: writes `local_meta` and this device's
    /// `known_devices` row; other devices learn the name from the sync
    /// handshake, not from the journal.
    RenameDevice {
        name: String,
    },

    // ---- link cards (MCP + enrichment) -----------------------------------
    CreateLinkBatch(CreateLinkBatchInput),
    /// Trashes every card of an agent batch as one undo unit.
    TrashLinkBatch {
        agent_batch_id: String,
    },
    /// The write half of link enrichment: the network phase ran elsewhere
    /// (`link_metadata::plan_embed_enrichment`) and staged the images. Records
    /// the staged asset rows, the favicon-cache rows and the card update; on
    /// error the staged files are discarded here (the writer owns the plan).
    ApplyEmbedMetadata(Box<link_metadata::EmbedEnrichmentPlan>),

    // ---- maintenance (startup, background) -------------------------------
    /// Retired by hash dedup (P1.2): every import path, link enrichment
    /// included, now reuses an existing asset with the same SHA-256, so new
    /// favicon duplicates are no longer created. Kept for one more release to
    /// collapse duplicates created before migration 0020; delete this variant
    /// and `link_metadata::collapse_favicon_duplicates` in the next release.
    CollapseFaviconDuplicates,
    CollectOrphanedAssets,
    /// Background backfill of `assets.sha256` for rows created before
    /// migration 0020 (see `asset_service::hash_existing_assets`).
    HashExistingAssets,
}

/// Payload of [`Mutation::CommitFileCard`].
pub struct CommitFileCard {
    pub input: CreateFileCardInput,
    pub asset: AssetDto,
    pub new_asset: Option<StagedAsset>,
    pub preview_text: String,
    pub thumbnail: Option<StagedAsset>,
}

/// What a mutation produced. Callers use the `into_*` accessors; a mismatch is
/// a programming error surfaced as `WorkspaceError::Database`, never a panic
/// on the writer thread.
pub enum MutationOutcome {
    Unit,
    Id(String),
    Count(i64),
    Card(CardDto),
    /// Boxed: the embed projection is the largest outcome by far.
    Embed(Box<EmbedCardDto>),
    MoveSelectionReceipt(MoveSelectionToBoardReceipt),
    DuplicateBoardReceipt(DuplicateBoardReceipt),
    EmptyTrash(EmptyTrashResult),
    LinkBatch(CreateLinkBatchResult),
    /// Card-level writes (P1.5): the revision read back in the transaction.
    CardReceipt(CardReceipt),
    /// Text writes: revision plus the backend-derived plain text.
    TextReceipt(TextReceipt),
    CardsReceipt(CardsReceipt),
    ViewportReceipt(ViewportReceipt),
    Device(DeviceIdentity),
}

fn unexpected(what: &str) -> WorkspaceError {
    WorkspaceError::Database(format!("unexpected mutation outcome: expected {what}"))
}

impl MutationOutcome {
    pub fn into_unit(self) -> Result<(), WorkspaceError> {
        match self {
            Self::Unit => Ok(()),
            _ => Err(unexpected("unit")),
        }
    }
    pub fn into_id(self) -> Result<String, WorkspaceError> {
        match self {
            Self::Id(id) => Ok(id),
            _ => Err(unexpected("id")),
        }
    }
    pub fn into_count(self) -> Result<i64, WorkspaceError> {
        match self {
            Self::Count(n) => Ok(n),
            _ => Err(unexpected("count")),
        }
    }
    pub fn into_card(self) -> Result<CardDto, WorkspaceError> {
        match self {
            Self::Card(card) => Ok(card),
            _ => Err(unexpected("card")),
        }
    }
    pub fn into_embed(self) -> Result<EmbedCardDto, WorkspaceError> {
        match self {
            Self::Embed(card) => Ok(*card),
            _ => Err(unexpected("embed card")),
        }
    }
    pub fn into_move_selection_receipt(
        self,
    ) -> Result<MoveSelectionToBoardReceipt, WorkspaceError> {
        match self {
            Self::MoveSelectionReceipt(r) => Ok(r),
            _ => Err(unexpected("move-selection receipt")),
        }
    }
    pub fn into_duplicate_board_receipt(self) -> Result<DuplicateBoardReceipt, WorkspaceError> {
        match self {
            Self::DuplicateBoardReceipt(r) => Ok(r),
            _ => Err(unexpected("duplicate-board receipt")),
        }
    }
    pub fn into_empty_trash(self) -> Result<EmptyTrashResult, WorkspaceError> {
        match self {
            Self::EmptyTrash(r) => Ok(r),
            _ => Err(unexpected("empty-trash result")),
        }
    }
    pub fn into_link_batch(self) -> Result<CreateLinkBatchResult, WorkspaceError> {
        match self {
            Self::LinkBatch(r) => Ok(r),
            _ => Err(unexpected("link-batch result")),
        }
    }
    pub fn into_card_receipt(self) -> Result<CardReceipt, WorkspaceError> {
        match self {
            Self::CardReceipt(r) => Ok(r),
            _ => Err(unexpected("card receipt")),
        }
    }
    pub fn into_text_receipt(self) -> Result<TextReceipt, WorkspaceError> {
        match self {
            Self::TextReceipt(r) => Ok(r),
            _ => Err(unexpected("text receipt")),
        }
    }
    pub fn into_cards_receipt(self) -> Result<CardsReceipt, WorkspaceError> {
        match self {
            Self::CardsReceipt(r) => Ok(r),
            _ => Err(unexpected("cards receipt")),
        }
    }
    pub fn into_viewport_receipt(self) -> Result<ViewportReceipt, WorkspaceError> {
        match self {
            Self::ViewportReceipt(r) => Ok(r),
            _ => Err(unexpected("viewport receipt")),
        }
    }
    pub fn into_device(self) -> Result<DeviceIdentity, WorkspaceError> {
        match self {
            Self::Device(d) => Ok(d),
            _ => Err(unexpected("device identity")),
        }
    }
}

impl Mutation {
    /// Stable operation name: the telemetry `op` field and, later, the journal
    /// `op` column. Snake case, never renamed once journaled.
    pub fn name(&self) -> &'static str {
        match self {
            Self::CreateNote(_) => "card.create_note",
            Self::CreateImageCard(_) => "card.create_image",
            Self::CreateBoardShortcut(_) => "card.create_board_shortcut",
            Self::UpdateNote(_) => "card.update_note",
            Self::SetNoteColor(_) => "card.set_note_color",
            Self::UpdateImageCaption(_) => "card.update_image_caption",
            Self::MoveCard(_) => "card.move",
            Self::MoveCards(_) => "card.move_many",
            Self::MoveCardToBoard(_) => "card.move_to_board",
            Self::MoveCardsToBoardUnsorted(_) => "card.move_many_to_unsorted",
            Self::PlaceUnsortedCard(_) => "card.place_unsorted",
            Self::ConvertNoteToEmbed(_) => "card.convert_note_to_embed",
            Self::UpdateEmbedDescription(_) => "card.update_embed_description",
            Self::MoveSelectionToBoard(_) => "selection.move_to_board",
            Self::UndoMoveSelection(_) => "selection.undo_move",
            Self::SaveViewport(_) => "board.save_viewport",
            Self::CreateChildBoard(_) => "board.create_child",
            Self::RenameBoard { .. } => "board.rename",
            Self::MoveBoard(_) => "board.move",
            Self::SetBoardCover { .. } => "board.set_cover",
            Self::DuplicateBoard(_) => "board.duplicate",
            Self::TrashNote { .. } => "trash.note",
            Self::TrashBoard { .. } => "trash.board",
            Self::TrashSelection(_) => "trash.selection",
            Self::RestoreTrashBatch { .. } => "trash.restore_batch",
            Self::EmptyTrash { .. } => "trash.empty",
            Self::AddQuickBoard(_) => "quick_board.add",
            Self::RemoveQuickBoard { .. } => "quick_board.remove",
            Self::ReorderQuickBoards(_) => "quick_board.reorder",
            Self::InsertAsset(_) => "asset.insert",
            Self::CreateFilesystemAlias(_) => "card.create_filesystem_alias",
            Self::RefreshFilesystemAliasLocator { .. } => "card.refresh_alias_locator",
            Self::CommitFileCard(_) => "card.create_file",
            Self::SetFilesystemAliasLocalTarget { .. } => "card.set_alias_local_target",
            Self::RenameDevice { .. } => "device.rename",
            Self::CreateLinkBatch(_) => "link_batch.create",
            Self::TrashLinkBatch { .. } => "link_batch.trash",
            Self::ApplyEmbedMetadata(_) => "card.apply_embed_metadata",
            Self::CollapseFaviconDuplicates => "maintenance.collapse_favicons",
            Self::CollectOrphanedAssets => "maintenance.collect_orphaned_assets",
            Self::HashExistingAssets => "maintenance.hash_assets",
        }
    }

    /// True for writes that touch only [`LOCAL_ONLY_TABLES`]: the journal (S1)
    /// must not record them and a replay must never produce them. Exhaustive
    /// on purpose: a new variant has to decide.
    pub fn is_local_only(&self) -> bool {
        match self {
            Self::SaveViewport(_)
            | Self::SetFilesystemAliasLocalTarget { .. }
            | Self::RenameDevice { .. } => true,
            Self::CreateNote(_)
            | Self::CreateImageCard(_)
            | Self::CreateBoardShortcut(_)
            | Self::UpdateNote(_)
            | Self::SetNoteColor(_)
            | Self::UpdateImageCaption(_)
            | Self::MoveCard(_)
            | Self::MoveCards(_)
            | Self::MoveCardToBoard(_)
            | Self::MoveCardsToBoardUnsorted(_)
            | Self::PlaceUnsortedCard(_)
            | Self::ConvertNoteToEmbed(_)
            | Self::UpdateEmbedDescription(_)
            | Self::MoveSelectionToBoard(_)
            | Self::UndoMoveSelection(_)
            | Self::CreateChildBoard(_)
            | Self::RenameBoard { .. }
            | Self::MoveBoard(_)
            | Self::SetBoardCover { .. }
            | Self::DuplicateBoard(_)
            | Self::TrashNote { .. }
            | Self::TrashBoard { .. }
            | Self::TrashSelection(_)
            | Self::RestoreTrashBatch { .. }
            | Self::EmptyTrash { .. }
            | Self::AddQuickBoard(_)
            | Self::RemoveQuickBoard { .. }
            | Self::ReorderQuickBoards(_)
            | Self::InsertAsset(_)
            | Self::CreateFilesystemAlias(_)
            | Self::RefreshFilesystemAliasLocator { .. }
            | Self::CommitFileCard(_)
            | Self::CreateLinkBatch(_)
            | Self::TrashLinkBatch { .. }
            | Self::ApplyEmbedMetadata(_)
            | Self::CollapseFaviconDuplicates
            | Self::CollectOrphanedAssets
            | Self::HashExistingAssets => false,
        }
    }

    /// Applies the mutation on the writer connection. Runs on the writer
    /// thread only; the borrow (not a move) is what lets the writer re-run a
    /// mutation after a busy-database error.
    pub fn execute(
        &self,
        conn: &mut Connection,
        paths: &WorkspacePaths,
    ) -> Result<MutationOutcome, WorkspaceError> {
        use MutationOutcome as Out;
        match self {
            Self::CreateNote(input) => repo::create_note(conn, input).map(Out::CardReceipt),
            Self::CreateImageCard(input) => repo::create_image_card(conn, input).map(|_| Out::Unit),
            Self::CreateBoardShortcut(input) => {
                repo::create_board_shortcut(conn, input).map(Out::Card)
            }
            Self::UpdateNote(input) => repo::update_note(conn, input).map(Out::TextReceipt),
            Self::SetNoteColor(input) => repo::set_note_color(conn, input).map(|_| Out::Unit),
            Self::UpdateImageCaption(input) => {
                repo::update_image_caption(conn, input).map(Out::TextReceipt)
            }
            Self::MoveCard(input) => repo::update_card_frame(conn, input).map(Out::CardReceipt),
            Self::MoveCards(input) => repo::move_cards(conn, input).map(Out::CardsReceipt),
            Self::MoveCardToBoard(input) => {
                repo::move_card_to_board(conn, input).map(Out::CardReceipt)
            }
            Self::MoveCardsToBoardUnsorted(input) => {
                repo::move_cards_to_board_unsorted(conn, input).map(Out::CardsReceipt)
            }
            Self::PlaceUnsortedCard(input) => {
                repo::place_unsorted_card(conn, input).map(Out::CardReceipt)
            }
            Self::ConvertNoteToEmbed(input) => {
                repo::convert_note_to_embed(conn, input).map(|c| Out::Embed(Box::new(c)))
            }
            Self::UpdateEmbedDescription(input) => {
                repo::update_embed_description(conn, input).map(Out::TextReceipt)
            }
            Self::MoveSelectionToBoard(input) => {
                move_selection::move_selection_to_board(conn, input).map(Out::MoveSelectionReceipt)
            }
            Self::UndoMoveSelection(receipt) => {
                move_selection::undo_move_selection(conn, receipt).map(|_| Out::Unit)
            }

            Self::SaveViewport(input) => {
                repo::update_viewport(conn, input).map(Out::ViewportReceipt)
            }
            Self::CreateChildBoard(input) => {
                board_service::create_child_board(conn, input).map(|_| Out::Unit)
            }
            Self::RenameBoard { board_id, title } => {
                board_service::rename_board(conn, board_id, title).map(|_| Out::Unit)
            }
            Self::MoveBoard(input) => board_service::move_board(conn, input).map(|_| Out::Unit),
            Self::SetBoardCover { board_id, asset_id } => {
                board_service::set_board_cover(conn, board_id, asset_id.as_deref())
                    .map(|_| Out::Unit)
            }
            Self::DuplicateBoard(input) => {
                duplicate_board::duplicate_board(conn, input).map(Out::DuplicateBoardReceipt)
            }

            Self::TrashNote { card_id } => trash_service::trash_note(conn, card_id).map(Out::Id),
            Self::TrashBoard { board_id } => {
                trash_service::trash_board(conn, board_id).map(Out::Id)
            }
            Self::TrashSelection(input) => trash_service::trash_selection(conn, input).map(Out::Id),
            Self::RestoreTrashBatch { batch_id } => {
                trash_service::restore_trash_batch(conn, batch_id).map(|_| Out::Unit)
            }
            Self::EmptyTrash { confirmation } => {
                // Mandatory pre-empty backup gate: refuse to mutate unless a
                // fresh validated snapshot is on disk. Runs here, on the writer
                // thread, so it never blocks the UI and no write can interleave
                // between the snapshot and the delete.
                crate::db::backup::snapshot_before_destructive_operation(
                    &paths.db_path(),
                    &paths.assets_dir(),
                    &paths.backups_dir(),
                )
                .map_err(WorkspaceError::Database)?;
                trash_service::empty_trash(conn, confirmation).map(Out::EmptyTrash)
            }

            Self::AddQuickBoard(input) => repo::add_quick_board(conn, input).map(|_| Out::Unit),
            Self::RemoveQuickBoard { board_id } => {
                repo::remove_quick_board(conn, board_id).map(|_| Out::Unit)
            }
            Self::ReorderQuickBoards(input) => {
                repo::reorder_quick_boards(conn, input).map(|_| Out::Unit)
            }

            Self::InsertAsset(asset) => {
                asset_service::insert_asset_row(conn, asset).map(|_| Out::Unit)
            }
            Self::CreateFilesystemAlias(input) => {
                repo::create_filesystem_alias(conn, input)?;
                // The persisted projection (origin device name, `local`).
                repo::load_card(conn, &input.id).map(Out::Card)
            }
            Self::SetFilesystemAliasLocalTarget {
                card_id,
                locator_blob,
            } => {
                repo::set_filesystem_alias_local_target(conn, card_id, locator_blob)?;
                repo::load_card(conn, card_id).map(Out::Card)
            }
            Self::RenameDevice { name } => devices::rename_device(conn, name).map(Out::Device),
            Self::RefreshFilesystemAliasLocator {
                card_id,
                locator_blob,
                path_hint,
                display_name,
            } => repo::refresh_filesystem_alias_locator(
                conn,
                card_id,
                locator_blob,
                path_hint,
                display_name,
            )
            .map(|_| Out::Unit),
            Self::CommitFileCard(job) => {
                asset_service::commit_file_card(
                    conn,
                    &job.input,
                    &job.asset,
                    job.new_asset.as_ref(),
                    &job.preview_text,
                    job.thumbnail.as_ref(),
                )?;
                // Return the persisted projection so the caller sees exactly
                // what was stored (thumbnail included) without a reload.
                repo::load_card(conn, &job.input.id).map(Out::Card)
            }

            Self::CreateLinkBatch(input) => {
                repo::create_link_batch(conn, input).map(Out::LinkBatch)
            }
            Self::TrashLinkBatch { agent_batch_id } => {
                trash_link_batch(conn, agent_batch_id).map(Out::Id)
            }
            Self::ApplyEmbedMetadata(plan) => {
                link_metadata::commit_embed_enrichment(conn, plan).map(|c| Out::Embed(Box::new(c)))
            }

            Self::CollapseFaviconDuplicates => {
                link_metadata::collapse_favicon_duplicates(conn, &paths.assets_dir())
                    .map(Out::Count)
            }
            Self::CollectOrphanedAssets => {
                asset_service::collect_orphaned_assets(conn, &paths.assets_dir()).map(Out::Count)
            }
            Self::HashExistingAssets => {
                asset_service::hash_existing_assets(conn, &paths.assets_dir()).map(Out::Count)
            }
        }
    }
}

/// Trashes all cards of an agent batch as one undo unit. Returns the trash
/// batch id, or `NotFound` if the agent batch id is unknown or empty.
fn trash_link_batch(conn: &mut Connection, agent_batch_id: &str) -> Result<String, WorkspaceError> {
    use crate::domain::models::TrashItem;
    let card_ids = repo::load_batch_card_ids(conn, agent_batch_id)?
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
