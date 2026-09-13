//! Repository for reading board snapshots and creating notes.
//!
//! SQLite is authoritative (ADR-003). These functions are the only place that
//! maps database rows to domain DTOs and back.

// Quick Boards live in their own aggregate module; re-exported so every existing
// `workspace_repository::…` path keeps working.
pub use super::assets::*;
pub use super::boards::*;
pub use super::cards::*;
pub use super::move_selection::*;
pub use super::quick_boards::*;
pub use super::receipts::*;
pub use super::search::*;
