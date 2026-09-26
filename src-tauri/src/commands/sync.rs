//! Device-sync commands (ADR-0011).
//!
//! S1/S2 (transport-agnostic, debugging):
//! - `sync_export_changes(cursors, limit?)` → `{ rows, next }`: the rows this
//!   device holds that a peer with `cursors` lacks, one page at a time.
//! - `sync_apply_changes(rows)` → `ApplyReport`: replays a peer's rows through
//!   the writer. Emits [`SYNC_APPLIED_EVENT`] with the touched board ids:
//!   replay commits on this process's own writer connection, so the P1.6
//!   external-change poll (which requires `data_version` to move) would not
//!   reload the open board by itself.
//! - `sync_status()` → `{ deviceId, cursors, pendingCount, missingBlobs }`.
//!
//! S3 (LAN transport, `sync::lan`; the Devices dialog):
//! - `get_sync_state()` / `sync_list_peers()` / `sync_list_discovered()`
//! - `sync_begin_pairing()` → `{ code, expiresAt }`, `sync_cancel_pairing()`
//! - `sync_pair_with({ deviceId?, address?, code })` → the new peer
//! - `sync_unpair(deviceId)`, `sync_now()` → the state after one pass
//!
//! Events: [`SYNC_APPLIED_EVENT`] (touched board ids) and
//! [`SYNC_STATE_EVENT`] ([`SyncState`]).
use std::collections::BTreeMap;
use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

use crate::{
    app::Workspace,
    domain::{errors::WorkspaceError, mutation::Mutation},
    sync::{
        journal::{self, ChangePage, SyncStatus},
        lan::{DiscoveredDevice, LanSync, PairingCode, PeerState, SyncEvents, SyncState},
        ApplyReport, ChangeRow,
    },
    telemetry::instrument_async,
};

/// Tauri event emitted after a replay changed boards (payload: board ids).
pub const SYNC_APPLIED_EVENT: &str = "sync-applied";
/// Tauri event carrying the LAN sync state ([`SyncState`]).
pub const SYNC_STATE_EVENT: &str = "sync-state";

/// Managed state: the LAN sync service, or why it could not start (the app
/// runs without sync then; every S3 command reports the reason).
pub struct LanState {
    pub lan: Option<Arc<LanSync>>,
    pub error: Option<String>,
}

impl LanState {
    fn get(&self) -> Result<Arc<LanSync>, WorkspaceError> {
        self.lan.clone().ok_or_else(|| {
            WorkspaceError::Sync(
                self.error
                    .clone()
                    .unwrap_or_else(|| "sync is not running".into()),
            )
        })
    }
}

/// Forwards the service's reports as Tauri events.
pub struct TauriSyncEvents(pub AppHandle);

impl SyncEvents for TauriSyncEvents {
    fn state(&self, state: &SyncState) {
        let _ = self.0.emit(SYNC_STATE_EVENT, state);
    }

    fn applied(&self, boards: &[String]) {
        let _ = self.0.emit(SYNC_APPLIED_EVENT, boards);
    }
}

#[tauri::command]
pub async fn get_sync_state(lan: State<'_, LanState>) -> Result<SyncState, WorkspaceError> {
    let lan = lan.get()?;
    instrument_async("get_sync_state", async move { lan.state().await }).await
}

#[tauri::command]
pub async fn sync_list_peers(lan: State<'_, LanState>) -> Result<Vec<PeerState>, WorkspaceError> {
    let lan = lan.get()?;
    instrument_async(
        "sync_list_peers",
        async move { Ok(lan.state().await?.peers) },
    )
    .await
}

#[tauri::command]
pub async fn sync_list_discovered(
    lan: State<'_, LanState>,
) -> Result<Vec<DiscoveredDevice>, WorkspaceError> {
    let lan = lan.get()?;
    instrument_async(
        "sync_list_discovered",
        async move { lan.discovered().await },
    )
    .await
}

#[tauri::command]
pub async fn sync_begin_pairing(lan: State<'_, LanState>) -> Result<PairingCode, WorkspaceError> {
    let lan = lan.get()?;
    instrument_async("sync_begin_pairing", async move { lan.begin_pairing() }).await
}

#[tauri::command]
pub async fn sync_cancel_pairing(lan: State<'_, LanState>) -> Result<(), WorkspaceError> {
    let lan = lan.get()?;
    lan.cancel_pairing();
    Ok(())
}

/// `sync_pair_with` input: a discovered device OR a `host:port` address.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairWithInput {
    pub device_id: Option<String>,
    pub address: Option<String>,
    pub code: String,
}

#[tauri::command]
pub async fn sync_pair_with(
    lan: State<'_, LanState>,
    input: PairWithInput,
) -> Result<PeerState, WorkspaceError> {
    let lan = lan.get()?;
    instrument_async("sync_pair_with", async move {
        lan.pair_with(
            input.device_id.as_deref(),
            input.address.as_deref(),
            &input.code,
        )
        .await
    })
    .await
}

#[tauri::command]
pub async fn sync_unpair(
    lan: State<'_, LanState>,
    device_id: String,
) -> Result<(), WorkspaceError> {
    let lan = lan.get()?;
    instrument_async("sync_unpair", async move { lan.unpair(&device_id).await }).await
}

#[tauri::command]
pub async fn sync_now(lan: State<'_, LanState>) -> Result<SyncState, WorkspaceError> {
    let lan = lan.get()?;
    instrument_async("sync_now", async move {
        lan.sync_now().await;
        lan.state().await
    })
    .await
}

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
