//! Domain error types surfaced at the IPC boundary.

use serde::Serialize;

/// The authoritative error kind returned by workspace commands.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "code", content = "message", rename_all = "snake_case")]
pub enum WorkspaceError {
    /// A referenced board/workspace does not exist.
    NotFound(String),
    /// A mutation carried a stale `expected_revision`.
    StaleRevision { expected: i64, actual: i64 },
    /// A constraint from the schema or domain invariant was violated.
    ConstraintViolation(String),
    /// The root board was operated on in a disallowed way.
    RootBoardProtected,
    /// An unexpected database failure.
    Database(String),
}

impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkspaceError::NotFound(m) => write!(f, "not found: {m}"),
            WorkspaceError::StaleRevision { expected, actual } => {
                write!(f, "stale revision: expected {expected}, actual {actual}")
            }
            WorkspaceError::ConstraintViolation(m) => write!(f, "constraint violation: {m}"),
            WorkspaceError::RootBoardProtected => write!(f, "root board is protected"),
            WorkspaceError::Database(m) => write!(f, "database error: {m}"),
        }
    }
}

impl WorkspaceError {
    /// True when the failure is SQLite reporting a busy/locked database, i.e.
    /// another process held the write lock past `busy_timeout`. The writer
    /// thread re-runs such mutations a bounded number of times. Detected on
    /// the message because `Database` carries only a string at the IPC
    /// boundary; `From<rusqlite::Error>` below writes these messages, so the
    /// two stay in step.
    pub fn is_busy(&self) -> bool {
        match self {
            WorkspaceError::Database(message) => {
                message.contains("database is locked") || message.contains("database table is locked")
            }
            _ => false,
        }
    }
}

impl std::error::Error for WorkspaceError {}

impl From<rusqlite::Error> for WorkspaceError {
    fn from(e: rusqlite::Error) -> Self {
        WorkspaceError::Database(e.to_string())
    }
}
