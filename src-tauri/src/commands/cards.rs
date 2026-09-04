//! Card-related Tauri commands.

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::State;

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{
    CreateImageCardInput, CreateNoteInput, MoveCardsInput, UpdateCardFrameInput,
    UpdateImageCaptionInput, UpdateNoteInput,
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
