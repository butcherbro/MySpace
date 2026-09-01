//! First-run bootstrap: create exactly one workspace and one Home root board.
//!
//! V1 exposes no workspace creation command and no second workspace path. This
//! module enforces the single-workspace invariant from Section C of the plan.

use rusqlite::{Connection, Result};

/// Creates the single workspace and Home root board if they do not exist.
///
/// Idempotent: if a workspace already exists, this is a no-op except that it
/// backfills a missing Home view-state row (for databases created before
/// view-state bootstrap existed).
pub fn bootstrap(conn: &mut Connection) -> Result<()> {
    let existing: i64 = conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))?;
    if existing > 0 {
        backfill_home_view_state(conn)?;
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
    tx.execute(
        "INSERT INTO board_view_states (board_id, viewport_x, viewport_y, zoom, revision, updated_at)
         VALUES (?1, 0, 0, 1, 1, ?2)",
        rusqlite::params![home_board_id, now],
    )?;
    tx.commit()?;

    Ok(())
}

/// Backfills a missing Home view-state row for a pre-existing workspace.
fn backfill_home_view_state(conn: &Connection) -> Result<()> {
    conn.execute(
        "INSERT INTO board_view_states (board_id, viewport_x, viewport_y, zoom, revision, updated_at)
         SELECT w.root_board_id, 0, 0, 1, 1, ?1
         FROM workspaces w
         WHERE NOT EXISTS (
            SELECT 1 FROM board_view_states vst WHERE vst.board_id = w.root_board_id
         )",
        rusqlite::params![super::migrations::now_millis()],
    )?;
    Ok(())
}
