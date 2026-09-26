//! Card-related Tauri commands.
//!
//! Every command is `async` and touches the database only through the
//! [`Workspace`] handle: reads on the pool, writes as a [`Mutation`] on the
//! writer thread.

use tauri::State;

use crate::app::Workspace;
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{
    CardDto, CardReceipt, CardsReceipt, ConvertNoteToEmbedInput, CreateBoardShortcutInput,
    CreateImageCardInput, CreateNoteInput, EmbedCardDto, MoveCardToBoardInput, MoveCardsInput,
    MoveCardsToUnsortedInput, PlaceUnsortedCardInput, SetNoteColorInput, TextReceipt,
    UpdateCardFrameInput, UpdateEmbedDescriptionInput, UpdateImageCaptionInput, UpdateNoteInput,
};
use crate::domain::mutation::Mutation;
use crate::repositories::workspace_repository;
use crate::telemetry::instrument_async;

/// Creates a note card on the given board in a single transaction.
#[tauri::command]
pub async fn create_note(
    ws: State<'_, Workspace>,
    input: CreateNoteInput,
) -> Result<CardReceipt, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("create_note", async move {
        ws.apply(Mutation::CreateNote(input))
            .await?
            .into_card_receipt()
    })
    .await
}

/// Creates an image card referencing an already-imported asset.
#[tauri::command]
pub async fn create_image_card(
    ws: State<'_, Workspace>,
    input: CreateImageCardInput,
) -> Result<(), WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("create_image_card", async move {
        ws.apply(Mutation::CreateImageCard(input))
            .await?
            .into_unit()
    })
    .await
}

/// Creates a board shortcut card (todo.md №17): "Create shortcut" on a Board
/// Portal or on another shortcut. Returns the created card's full projection.
#[tauri::command]
pub async fn create_board_shortcut(
    ws: State<'_, Workspace>,
    input: CreateBoardShortcutInput,
) -> Result<CardDto, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("create_board_shortcut", async move {
        ws.apply(Mutation::CreateBoardShortcut(input))
            .await?
            .into_card()
    })
    .await
}

/// Updates a note's content with an optimistic revision guard.
#[tauri::command]
pub async fn update_note(
    ws: State<'_, Workspace>,
    input: UpdateNoteInput,
) -> Result<TextReceipt, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("update_note", async move {
        ws.apply(Mutation::UpdateNote(input))
            .await?
            .into_text_receipt()
    })
    .await
}

/// Sets a note card's background color preset (does not bump revision).
#[tauri::command]
pub async fn set_note_color(
    ws: State<'_, Workspace>,
    input: SetNoteColorInput,
) -> Result<(), WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("set_note_color", async move {
        ws.apply(Mutation::SetNoteColor(input)).await?.into_unit()
    })
    .await
}

/// Updates an image card's caption, bumping its revision.
#[tauri::command]
pub async fn update_image_caption(
    ws: State<'_, Workspace>,
    input: UpdateImageCaptionInput,
) -> Result<TextReceipt, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("update_image_caption", async move {
        ws.apply(Mutation::UpdateImageCaption(input))
            .await?
            .into_text_receipt()
    })
    .await
}

/// Moves/resizes a card (note or portal) with an optimistic revision guard.
#[tauri::command]
pub async fn move_card(
    ws: State<'_, Workspace>,
    input: UpdateCardFrameInput,
) -> Result<CardReceipt, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("move_card", async move {
        ws.apply(Mutation::MoveCard(input))
            .await?
            .into_card_receipt()
    })
    .await
}

/// Moves multiple cards atomically in a single transaction.
#[tauri::command]
pub async fn move_cards(
    ws: State<'_, Workspace>,
    input: MoveCardsInput,
) -> Result<CardsReceipt, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("move_cards", async move {
        ws.apply(Mutation::MoveCards(input))
            .await?
            .into_cards_receipt()
    })
    .await
}

/// Moves a leaf card to a different board (drop onto a board portal).
#[tauri::command]
pub async fn move_card_to_board(
    ws: State<'_, Workspace>,
    input: MoveCardToBoardInput,
) -> Result<CardReceipt, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("move_card_to_board", async move {
        ws.apply(Mutation::MoveCardToBoard(input))
            .await?
            .into_card_receipt()
    })
    .await
}

/// Atomically moves a group of cards into a Board's Unsorted panel.
#[tauri::command]
pub async fn move_cards_to_board_unsorted(
    ws: State<'_, Workspace>,
    input: MoveCardsToUnsortedInput,
) -> Result<CardsReceipt, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("move_cards_to_board_unsorted", async move {
        ws.apply(Mutation::MoveCardsToBoardUnsorted(input))
            .await?
            .into_cards_receipt()
    })
    .await
}

/// Places one Unsorted card onto the board at an exact frame.
#[tauri::command]
pub async fn place_unsorted_card(
    ws: State<'_, Workspace>,
    input: PlaceUnsortedCardInput,
) -> Result<CardReceipt, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("place_unsorted_card", async move {
        ws.apply(Mutation::PlaceUnsortedCard(input))
            .await?
            .into_card_receipt()
    })
    .await
}

/// Reads a single card by id (any kind).
#[tauri::command]
pub async fn read_card(
    ws: State<'_, Workspace>,
    card_id: String,
) -> Result<CardDto, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("read_card", async move {
        ws.read(move |conn| workspace_repository::load_card(conn, &card_id))
            .await
    })
    .await
}

/// Transactionally converts a Note into an Embed (Link) Card, preserving the
/// card identity/frame/z-index and bumping its revision. Returns the authoritative
/// `EmbedCardDto` for the frontend to swap in.
#[tauri::command]
pub async fn convert_note_to_embed(
    ws: State<'_, Workspace>,
    input: ConvertNoteToEmbedInput,
) -> Result<EmbedCardDto, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("convert_note_to_embed", async move {
        ws.apply(Mutation::ConvertNoteToEmbed(input))
            .await?
            .into_embed()
    })
    .await
}

/// Updates an embed (Link) card's description body, bumping its revision.
#[tauri::command]
pub async fn update_embed_description(
    ws: State<'_, Workspace>,
    input: UpdateEmbedDescriptionInput,
) -> Result<TextReceipt, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("update_embed_description", async move {
        ws.apply(Mutation::UpdateEmbedDescription(input))
            .await?
            .into_text_receipt()
    })
    .await
}

/// Moves a whole selection — leaf cards and Board Portals together — onto one
/// board in a single atomic backend operation (ADR-0007).
#[tauri::command]
pub async fn move_selection_to_board(
    ws: State<'_, Workspace>,
    input: crate::domain::models::MoveSelectionToBoardInput,
) -> Result<crate::domain::models::MoveSelectionToBoardReceipt, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("move_selection_to_board", async move {
        ws.apply(Mutation::MoveSelectionToBoard(input))
            .await?
            .into_move_selection_receipt()
    })
    .await
}

/// Reverses a mixed-selection move from the receipt the move returned (ADR-0007).
#[tauri::command]
pub async fn undo_move_selection(
    ws: State<'_, Workspace>,
    receipt: crate::domain::models::MoveSelectionToBoardReceipt,
) -> Result<(), WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("undo_move_selection", async move {
        ws.apply(Mutation::UndoMoveSelection(receipt))
            .await?
            .into_unit()
    })
    .await
}
