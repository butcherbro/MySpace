//! Backup Tauri commands: list snapshots and request a restore.
//!
//! A restore cannot happen while the `Workspace` holds its connections, so
//! `request_restore` only validates the choice, writes the restore marker and
//! restarts the app; `db::backup::apply_pending_restore` performs the restore
//! during the next startup, before the database is opened.
//!
//! Both commands take the managed [`WorkspacePaths`], not the `Workspace`, so
//! they also work in recovery mode (P1.7), when no `Workspace` is managed.

use tauri::State;

use crate::app::WorkspacePaths;
use crate::db::backup::{self, BackupSummary};
use crate::domain::errors::WorkspaceError;
use crate::telemetry::instrument_async;

/// Lists backup snapshots, newest first, each validated on the spot.
#[tauri::command]
pub async fn list_backups(
    paths: State<'_, WorkspacePaths>,
) -> Result<Vec<BackupSummary>, WorkspaceError> {
    let backup_root = paths.backups_dir();
    instrument_async("list_backups", async move {
        tokio::task::spawn_blocking(move || backup::list_backups(&backup_root))
            .await
            .map_err(|e| WorkspaceError::Database(format!("list backups task failed: {e}")))
    })
    .await
}

/// Schedules a restore of `snapshot` (a directory name from `list_backups`)
/// and restarts the app. Returns only on error: on success the process
/// restarts and the restore runs before the workspace reopens.
#[tauri::command]
pub async fn request_restore(
    app: tauri::AppHandle,
    paths: State<'_, WorkspacePaths>,
    snapshot: String,
) -> Result<(), WorkspaceError> {
    let data_dir = paths.data_dir.clone();
    let backup_root = paths.backups_dir();
    instrument_async("request_restore", async move {
        if !backup::is_bare_snapshot_name(&snapshot) {
            return Err(WorkspaceError::ConstraintViolation(
                "snapshot must be a bare backup directory name".into(),
            ));
        }
        if !backup_root.join(&snapshot).is_dir() {
            return Err(WorkspaceError::NotFound(snapshot));
        }
        tokio::task::spawn_blocking(move || backup::request_restore(&data_dir, &snapshot))
            .await
            .map_err(|e| WorkspaceError::Database(format!("restore task failed: {e}")))?
            .map_err(WorkspaceError::Database)
    })
    .await?;
    tracing::info!("backup: restore requested, restarting");
    app.restart()
}
