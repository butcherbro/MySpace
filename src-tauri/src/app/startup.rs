//! Startup of the workspace database, and the recovery mode the app enters
//! when that fails (P1.7).
//!
//! Before P1.7 a database that could not be opened (corrupt file, failed
//! migration) panicked in `setup`, so the app simply vanished. Now
//! [`open_workspace`] turns the failure into a [`StartupFailure`]; `lib.rs`
//! then manages [`StartupState`] with it and does NOT manage a `Workspace`.
//! The frontend asks `get_startup_failure` first and, when it is set, renders
//! only the recovery dialog (restore from a backup snapshot, or quit) and
//! never invokes a command that needs the `Workspace`.

use serde::{Deserialize, Serialize};

use super::{Workspace, WorkspacePaths};
use crate::db;
use crate::telemetry::ErrorCode;

/// Why the workspace could not be started. `message` is an error code plus
/// generic text: never a path or database content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupFailure {
    /// Stable error code (`db_open_failed`, `workspace_start_failed`).
    pub code: String,
    /// User-facing text, prefixed with the code.
    pub message: String,
}

impl StartupFailure {
    fn new(code: &str, detail: Option<String>) -> Self {
        let tag = match detail {
            Some(detail) => format!("{code}/{detail}"),
            None => code.to_string(),
        };
        Self {
            code: code.to_string(),
            message: format!(
                "[{tag}] The workspace database could not be opened. \
                 You can restore it from a backup snapshot or quit."
            ),
        }
    }

    /// A failure to open, migrate or bootstrap the database file.
    pub fn from_open_error(error: &rusqlite::Error) -> Self {
        let detail = match error {
            rusqlite::Error::SqliteFailure(e, _) => Some(format!("sqlite_{}", e.extended_code)),
            _ => None,
        };
        Self::new("db_open_failed", detail)
    }
}

/// Managed in every mode: `Some` means the app started in recovery mode and
/// no `Workspace` is managed.
#[derive(Debug, Default)]
pub struct StartupState(pub Option<StartupFailure>);

/// Opens, migrates and bootstraps the workspace database and starts the
/// `Workspace`. A failure is logged at error level (code only) and returned
/// as a [`StartupFailure`] instead of panicking.
pub fn open_workspace(paths: WorkspacePaths) -> Result<Workspace, StartupFailure> {
    let conn = db::open_and_bootstrap(&paths.db_path()).map_err(|error| {
        let failure = StartupFailure::from_open_error(&error);
        tracing::error!(
            error_code = %failure.code,
            message = %failure.message,
            "startup: workspace database could not be opened; entering recovery mode"
        );
        failure
    })?;
    Workspace::from_connection(conn, paths).map_err(|error| {
        let failure = StartupFailure::new("workspace_start_failed", Some(error.code().into()));
        tracing::error!(
            error_code = %failure.code,
            message = %failure.message,
            "startup: workspace could not be started; entering recovery mode"
        );
        failure
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_data_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("myspace-startup-{tag}-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_garbage_database_file_yields_a_startup_failure() {
        let dir = temp_data_dir("garbage");
        let paths = WorkspacePaths::new(&dir);
        std::fs::write(
            paths.db_path(),
            b"this is definitely not an sqlite database file, just garbage bytes \
              long enough to fill a header page.................................",
        )
        .unwrap();

        let Err(failure) = open_workspace(paths) else {
            panic!("garbage must not open");
        };
        assert_eq!(failure.code, "db_open_failed");
        assert!(failure.message.starts_with("[db_open_failed/sqlite_26]"));
        let dir_text = dir.to_string_lossy();
        assert!(
            !failure.message.contains(dir_text.as_ref()) && !failure.message.contains("sqlite3"),
            "no paths in the message: {}",
            failure.message
        );
        let wire = serde_json::to_value(&failure).unwrap();
        assert_eq!(wire["code"], "db_open_failed");
        assert!(wire["message"].is_string());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_fresh_data_dir_opens_normally() {
        let dir = temp_data_dir("fresh");
        assert!(open_workspace(WorkspacePaths::new(&dir)).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }
}
