//! Device-sync commands (ADR-0011 S1/S2). Thin: a future transport (S3) or a
//! debugging surface drives them; there is no frontend UI yet.
//!
//! - `sync_export_changes(cursors, limit?)` → `{ rows, next }`: the rows this
//!   device holds that a peer with `cursors` lacks, one page at a time.
//! - `sync_apply_changes(rows)` → `ApplyReport`: replays a peer's rows through
//!   the writer. Emits [`SYNC_APPLIED_EVENT`] with the touched board ids:
//!   replay commits on this process's own writer connection, so the P1.6
//!   external-change poll (which requires `data_version` to move) would not
//!   reload the open board by itself.
//! - `sync_status()` → `{ deviceId, cursors, pendingCount, missingBlobs }`.
use std::collections::BTreeMap;

use tauri::{AppHandle, Emitter, State};

use crate::{
    app::Workspace,
    domain::{errors::WorkspaceError, mutation::Mutation},
    sync::{
        journal::{self, ChangePage, SyncStatus},
        ApplyReport, ChangeRow,
    },
    telemetry::instrument_async,
};

/// Tauri event emitted after a replay changed boards (payload: board ids).
pub const SYNC_APPLIED_EVENT: &str = "sync-applied";

#[tauri::command]
pub async fn sync_export_changes(
    ws: State<'_, Workspace>,
    cursors: BTreeMap<String, String>,
    limit: Option<usize>,
) -> Result<ChangePage, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("sync_export_changes", async move {
        ws.read(move |conn| {
            journal::changes_since(conn, &cursors, limit.unwrap_or(journal::DEFAULT_PAGE))
        })
        .await
    })
    .await
}

#[tauri::command]
pub async fn sync_apply_changes(
    app: AppHandle,
    ws: State<'_, Workspace>,
    rows: Vec<ChangeRow>,
) -> Result<ApplyReport, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("sync_apply_changes", async move {
        let report = ws
            .apply(Mutation::ApplySyncChanges(rows))
            .await?
            .into_sync_report()?;
        if !report.touched_boards.is_empty() {
            let _ = app.emit(SYNC_APPLIED_EVENT, &report.touched_boards);
        }
        Ok(report)
    })
    .await
}

#[tauri::command]
pub async fn sync_status(ws: State<'_, Workspace>) -> Result<SyncStatus, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("sync_status", async move {
        let assets_dir = ws.paths().assets_dir();
        ws.read(move |conn| journal::status(conn, &assets_dir))
            .await
    })
    .await
}
