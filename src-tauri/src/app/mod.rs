//! Application layer: the process-wide `Workspace` handle that owns the SQLite
//! connections and funnels every mutation through one writer (P1.1, ADR-0011).

pub mod workspace;

pub use workspace::{Workspace, WorkspacePaths};
