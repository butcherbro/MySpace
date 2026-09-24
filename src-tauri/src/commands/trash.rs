//! Trash-related Tauri commands.
//!
//! Every command is `async` and touches the database only through the
//! [`Workspace`] handle: reads on the pool, writes as a [`Mutation`] on the
//! writer thread. The `State` is cloned before the first `await` so no borrow
//! of Tauri state crosses an await point.

use tauri::State;

use crate::app::Workspace;
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{EmptyTrashResult, TrashSelectionInput, TrashSummaryDto};
use crate::domain::mutation::Mutation;
use crate::domain::trash_service;
use crate::telemetry::instrument_async;

/// Trashes a note card, returning its trash batch id.
#[tauri::command]
pub async fn trash_note(
    ws: State<'_, Workspace>,
    card_id: String,
) -> Result<String, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("trash_note", async move {
        ws.apply(Mutation::TrashNote { card_id }).await?.into_id()
    })
    .await
}

/// Trashes a board and its subtree, returning the trash batch id.
#[tauri::command]
pub async fn trash_board(
    ws: State<'_, Workspace>,
    board_id: String,
) -> Result<String, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("trash_board", async move {
        ws.apply(Mutation::TrashBoard { board_id }).await?.into_id()
    })
    .await
}

/// Restores a trash batch.
#[tauri::command]
pub async fn restore_trash_batch(
    ws: State<'_, Workspace>,
    batch_id: String,
) -> Result<(), WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("restore_trash_batch", async move {
        ws.apply(Mutation::RestoreTrashBatch { batch_id })
            .await?
            .into_unit()
    })
    .await
}

/// Atomically trashes a mixed selection (leaf cards + boards) in one
/// transaction, returning the single trash batch id.
#[tauri::command]
pub async fn trash_selection(
    ws: State<'_, Workspace>,
    input: TrashSelectionInput,
) -> Result<String, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("trash_selection", async move {
        ws.apply(Mutation::TrashSelection(input)).await?.into_id()
    })
    .await
}

/// Lists recoverable Trash batches (newest first) without mutating data.
#[tauri::command]
pub async fn list_trash(ws: State<'_, Workspace>) -> Result<TrashSummaryDto, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("list_trash", async move {
        ws.read(|conn| trash_service::list_trash(conn)).await
    })
    .await
}

/// Permanently empties the Trash. Requires the exact token `EMPTY`. A fresh
/// validated backup is created first (on the writer thread, see
/// `Mutation::EmptyTrash`); if it cannot be created or validated the operation
/// is refused before anything is deleted. Returns the affected counts (asset GC
/// follows on startup).
#[tauri::command]
pub async fn empty_trash(
    ws: State<'_, Workspace>,
    confirmation: String,
) -> Result<EmptyTrashResult, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("empty_trash", async move {
        ws.apply(Mutation::EmptyTrash { confirmation })
            .await?
            .into_empty_trash()
    })
    .await
}
