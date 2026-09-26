//! Board-related Tauri commands.
//!
//! Every command is `async` and touches the database only through the
//! [`Workspace`] handle: reads on the pool, writes as a [`Mutation`] on the
//! writer thread.

use tauri::State;

use crate::app::Workspace;
pub use crate::domain::board_service;
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{
    BoardSnapshot, BoardSummary, CreateChildBoardInput, DuplicateBoardInput, DuplicateBoardReceipt,
    MoveBoardInput, UpdateViewportInput, ViewportReceipt,
};
use crate::domain::mutation::Mutation;
use crate::repositories::boards as boards_repository;
use crate::repositories::boards::BoardChangeSeq;
use crate::repositories::workspace_repository;
use crate::telemetry::instrument_async;

/// Loads the full snapshot of a board by id.
#[tauri::command]
pub async fn load_board_snapshot(
    ws: State<'_, Workspace>,
    board_id: String,
) -> Result<BoardSnapshot, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("load_board_snapshot", async move {
        ws.read(move |conn| workspace_repository::load_board_snapshot(conn, &board_id))
            .await
    })
    .await
}

/// Returns the Home (root) board summary.
#[tauri::command]
pub async fn get_home_board(ws: State<'_, Workspace>) -> Result<BoardSummary, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("get_home_board", async move {
        ws.read(workspace_repository::load_home_board).await
    })
    .await
}

/// Persists a board's viewport.
#[tauri::command]
pub async fn save_viewport(
    ws: State<'_, Workspace>,
    input: UpdateViewportInput,
) -> Result<ViewportReceipt, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("save_viewport", async move {
        ws.apply(Mutation::SaveViewport(input))
            .await?
            .into_viewport_receipt()
    })
    .await
}

/// Returns what the frontend polls to detect external writes to the open
/// board (P1.6): `PRAGMA data_version` and the board's `change_seq`, both read
/// on the *writer* connection in one job.
///
/// `data_version` changes whenever *another* connection commits (the MCP
/// server, a second app instance), never on this process's own writes. It must
/// run on the writer connection on purpose: a pooled reader would report every
/// own commit as external. `change_seq` is bumped by triggers (migration 0023)
/// for every write that touches what the board renders, whoever made it. The
/// frontend reloads the open board only when BOTH moved since its last poll:
/// someone else wrote, and what they wrote touched this board. Own writes
/// (same `data_version`) never trigger a reload even though they bump
/// `change_seq`. Reading both in one closure keeps them a consistent pair.
///
/// `NotFound` if the board does not exist.
#[tauri::command]
pub async fn get_board_change_seq(
    ws: State<'_, Workspace>,
    board_id: String,
) -> Result<BoardChangeSeq, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("get_board_change_seq", async move {
        ws.inspect_writer(move |conn| boards_repository::get_board_change_seq(conn, &board_id))
            .await
    })
    .await
}

/// Creates a child board and its primary portal card atomically.
#[tauri::command]
pub async fn create_child_board(
    ws: State<'_, Workspace>,
    input: CreateChildBoardInput,
) -> Result<(), WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("create_child_board", async move {
        ws.apply(Mutation::CreateChildBoard(input))
            .await?
            .into_unit()
    })
    .await
}

/// Renames a board (portal title and breadcrumbs derive from this record).
#[tauri::command]
pub async fn rename_board(
    ws: State<'_, Workspace>,
    board_id: String,
    title: String,
) -> Result<(), WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("rename_board", async move {
        ws.apply(Mutation::RenameBoard { board_id, title })
            .await?
            .into_unit()
    })
    .await
}

/// Atomically reparents a Board and its portal card to a new parent board.
#[tauri::command]
pub async fn move_board(
    ws: State<'_, Workspace>,
    input: MoveBoardInput,
) -> Result<(), WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("move_board", async move {
        ws.apply(Mutation::MoveBoard(input)).await?.into_unit()
    })
    .await
}

/// Sets a Board's cover image from an already-imported asset id.
#[tauri::command]
pub async fn set_board_cover(
    ws: State<'_, Workspace>,
    board_id: String,
    asset_id: String,
) -> Result<(), WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("set_board_cover", async move {
        ws.apply(Mutation::SetBoardCover {
            board_id,
            asset_id: Some(asset_id),
        })
        .await?
        .into_unit()
    })
    .await
}

/// Removes a Board's cover image, returning to the color/symbol tile.
#[tauri::command]
pub async fn remove_board_cover(
    ws: State<'_, Workspace>,
    board_id: String,
) -> Result<(), WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("remove_board_cover", async move {
        ws.apply(Mutation::SetBoardCover {
            board_id,
            asset_id: None,
        })
        .await?
        .into_unit()
    })
    .await
}

/// Duplicates a Board Portal's whole subtree, recursively, in one atomic
/// transaction (todo.md №16).
#[tauri::command]
pub async fn duplicate_board(
    ws: State<'_, Workspace>,
    input: DuplicateBoardInput,
) -> Result<DuplicateBoardReceipt, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("duplicate_board", async move {
        ws.apply(Mutation::DuplicateBoard(input))
            .await?
            .into_duplicate_board_receipt()
    })
    .await
}
