//! Quick Boards Tauri commands: persisted, ordered references to Boards.

use tauri::State;

use crate::app::Workspace;
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{AddQuickBoardInput, QuickBoardDto, ReorderQuickBoardsInput};
use crate::domain::mutation::Mutation;
use crate::repositories::workspace_repository;
use crate::telemetry::instrument_async;

/// Lists Quick Boards in persisted order.
#[tauri::command]
pub async fn list_quick_boards(
    ws: State<'_, Workspace>,
) -> Result<Vec<QuickBoardDto>, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("list_quick_boards", async move {
        ws.read(workspace_repository::list_quick_boards).await
    })
    .await
}

/// Adds a Quick Board reference idempotently (non-Home, active Board only).
#[tauri::command]
pub async fn add_quick_board(
    ws: State<'_, Workspace>,
    input: AddQuickBoardInput,
) -> Result<(), WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("add_quick_board", async move {
        ws.apply(Mutation::AddQuickBoard(input)).await?.into_unit()
    })
    .await
}

/// Removes a Quick Board reference.
#[tauri::command]
pub async fn remove_quick_board(
    ws: State<'_, Workspace>,
    board_id: String,
) -> Result<(), WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("remove_quick_board", async move {
        ws.apply(Mutation::RemoveQuickBoard { board_id })
            .await?
            .into_unit()
    })
    .await
}

/// Reorders Quick Board references transactionally.
#[tauri::command]
pub async fn reorder_quick_boards(
    ws: State<'_, Workspace>,
    input: ReorderQuickBoardsInput,
) -> Result<(), WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("reorder_quick_boards", async move {
        ws.apply(Mutation::ReorderQuickBoards(input))
            .await?
            .into_unit()
    })
    .await
}
