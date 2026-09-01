//! First-run bootstrap: create exactly one workspace and one Home root board.
//!
//! V1 exposes no workspace creation command and no second workspace path. This
//! module enforces the single-workspace invariant from Section C of the plan.

use rusqlite::{Connection, Result};

/// Creates the single workspace and Home root board if they do not exist.
///
/// Idempotent: if a workspace already exists, this is a no-op.
pub fn bootstrap(conn: &mut Connection) -> Result<()> {
    let existing: i64 = conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))?;
    if existing > 0 {
        return Ok(());
    }

    let workspace_id = uuid::Uuid::now_v7().to_string();
    let home_board_id = uuid::Uuid::now_v7().to_string();
    let now = super::migrations::now_millis();

    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO workspaces (id, title, root_board_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![workspace_id, "Home", home_board_id, now, now],
    )?;
    tx.execute(
        "INSERT INTO boards (id, workspace_id, parent_board_id, title, color_token, symbol, revision, created_at, updated_at)
         VALUES (?1, ?2, NULL, ?3, ?4, NULL, 1, ?5, ?6)",
        rusqlite::params![home_board_id, workspace_id, "Home", "default", now, now],
    )?;
    tx.commit()?;

    Ok(())
}
