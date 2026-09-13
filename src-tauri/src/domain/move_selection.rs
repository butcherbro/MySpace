//! Mixed-selection move (ADR-0007). This module starts with the replay guard the
//! command and its receipt share; the atomic transaction lands here next.

use crate::domain::errors::WorkspaceError;
use crate::domain::models::MoveSelectionToBoardInput;

/// Canonical fingerprint of a mixed-selection request.
///
/// A replay of the same idempotency key must return the original receipt, while a
/// replay that reuses the key with a *different* payload must be rejected. The
/// fingerprint is the canonical JSON of the request rather than a hash: it needs
/// no hash dependency, and a stored hash is only useful if it is reproducible in
/// a later build, which `DefaultHasher` does not promise.
pub fn request_fingerprint(input: &MoveSelectionToBoardInput) -> Result<String, WorkspaceError> {
    // A struct serialises in declaration order, so the string is canonical.
    serde_json::to_string(input)
        .map_err(|error| WorkspaceError::Database(format!("cannot fingerprint request: {error}")))
}
