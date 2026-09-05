//! Concrete application service layer above repositories and domain services.
//!
//! Tauri, MCP, and any later CLI are thin adapters over `WorkspaceService`. This
//! boundary owns cross-cutting rules (entity addressing, idempotency, batch
//! identity) so the UI and external agents share business logic instead of
//! duplicating it (ADR-0005).

pub mod workspace_service;
