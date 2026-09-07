//! Card-related Tauri commands.

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::State;

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{
    CardDto, ConvertNoteToEmbedInput, CreateImageCardInput, CreateNoteInput, EmbedCardDto,
    MoveCardToBoardInput, MoveCardsInput, MoveCardsToUnsortedInput, PlaceUnsortedCardInput,
    UpdateCardFrameInput, UpdateEmbedDescriptionInput, UpdateImageCaptionInput, UpdateNoteInput,
};
use crate::repositories::workspace_repository;

/// The application-wide SQLite connection, guarded so commands can share it.
pub type DbState<'a> = State<'a, Mutex<Connection>>;

/// Creates a note card on the given board in a single transaction.
#[tauri::command]
pub fn create_note(db: DbState<'_>, input: CreateNoteInput) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::create_note(&mut conn, &input)
}

/// Creates an image card referencing an already-imported asset.
#[tauri::command]
pub fn create_image_card(
    db: DbState<'_>,
    input: CreateImageCardInput,
) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::create_image_card(&mut conn, &input)
}

/// Updates a note's content with an optimistic revision guard.
#[tauri::command]
pub fn update_note(db: DbState<'_>, input: UpdateNoteInput) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::update_note(&mut conn, &input)
}

/// Updates an image card's caption, bumping its revision.
#[tauri::command]
pub fn update_image_caption(
    db: DbState<'_>,
    input: UpdateImageCaptionInput,
) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::update_image_caption(&mut conn, &input)
}

/// Moves/resizes a card (note or portal) with an optimistic revision guard.
#[tauri::command]
pub fn move_card(db: DbState<'_>, input: UpdateCardFrameInput) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::update_card_frame(&mut conn, &input)
}

/// Moves multiple cards atomically in a single transaction.
#[tauri::command]
pub fn move_cards(db: DbState<'_>, input: MoveCardsInput) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::move_cards(&mut conn, &input)
}

/// Moves a leaf card to a different board (drop onto a board portal).
#[tauri::command]
pub fn move_card_to_board(
    db: DbState<'_>,
    input: MoveCardToBoardInput,
) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::move_card_to_board(&mut conn, &input)
}

/// Atomically moves a group of cards into a Board's Unsorted panel.
#[tauri::command]
pub fn move_cards_to_board_unsorted(
    db: DbState<'_>,
    input: MoveCardsToUnsortedInput,
) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::move_cards_to_board_unsorted(&mut conn, &input)
}

/// Places one Unsorted card onto the board at an exact frame.
#[tauri::command]
pub fn place_unsorted_card(
    db: DbState<'_>,
    input: PlaceUnsortedCardInput,
) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::place_unsorted_card(&mut conn, &input)
}

/// Reads a single card by id (any kind).
#[tauri::command]
pub fn read_card(db: DbState<'_>, card_id: String) -> Result<CardDto, WorkspaceError> {
    let conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::load_card(&conn, &card_id)
}

/// Transactionally converts a Note into an Embed (Link) Card, preserving the
/// card identity/frame/z-index and bumping its revision. Returns the authoritative
/// `EmbedCardDto` for the frontend to swap in.
#[tauri::command]
pub fn convert_note_to_embed(
    db: DbState<'_>,
    input: ConvertNoteToEmbedInput,
) -> Result<EmbedCardDto, WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::convert_note_to_embed(&mut conn, &input)
}

/// Updates an embed (Link) card's description body, bumping its revision.
#[tauri::command]
pub fn update_embed_description(
    db: DbState<'_>,
    input: UpdateEmbedDescriptionInput,
) -> Result<(), WorkspaceError> {
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::update_embed_description(&mut conn, &input)
}
