//! Application layer: the process-wide `Workspace` handle that owns the SQLite
//! connections and funnels every mutation through one writer (P1.1, ADR-0011),
//! and the startup/recovery-mode wiring around it (P1.7).

pub mod startup;
pub mod workspace;

pub use startup::{open_workspace, StartupFailure, StartupState};
pub use workspace::{Workspace, WorkspacePaths};
