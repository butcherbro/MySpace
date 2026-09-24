//! Device identity commands (ADR-0012 §1). There is no settings surface yet;
//! the frontend reads the identity through the gateway and the shortcut badge
//! reads the origin device's name from the alias projection.
use crate::{
    app::Workspace,
    domain::{device::DeviceIdentity, errors::WorkspaceError, mutation::Mutation},
    repositories::devices,
    telemetry::instrument_async,
};
use tauri::State;

/// This installation's `{ deviceId, deviceName }`.
#[tauri::command]
pub async fn get_device_identity(
    ws: State<'_, Workspace>,
) -> Result<DeviceIdentity, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("get_device_identity", async move {
        ws.read(devices::load_device_identity).await
    })
    .await
}

/// Renames this device (trimmed, 1..=64 characters). Device-local write.
#[tauri::command]
pub async fn rename_device(
    ws: State<'_, Workspace>,
    name: String,
) -> Result<DeviceIdentity, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("rename_device", async move {
        ws.apply(Mutation::RenameDevice { name })
            .await?
            .into_device()
    })
    .await
}
