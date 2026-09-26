//! Startup Tauri command: tells the frontend whether the app started in
//! recovery mode (P1.7). Needs no `Workspace`, so it works in that mode.

use tauri::State;

use crate::app::{StartupFailure, StartupState};

/// `Some` when the workspace database could not be opened at startup; the
/// frontend then shows only the recovery dialog.
#[tauri::command]
pub fn get_startup_failure(state: State<'_, StartupState>) -> Option<StartupFailure> {
    state.0.clone()
}
