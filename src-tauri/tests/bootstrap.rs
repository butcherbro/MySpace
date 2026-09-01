//! First-run bootstrap: exactly one workspace and one Home root board.

use myspace_lib::db::{bootstrap, open_in_memory};

#[test]
fn bootstrap_creates_exactly_one_workspace_and_home_board() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();

    let workspace_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
        .unwrap();
    assert_eq!(workspace_count, 1, "must have exactly one workspace");

    let board_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM boards", [], |r| r.get(0))
        .unwrap();
    assert_eq!(board_count, 1, "must have exactly one Home board");

    let (root_board_id, title): (String, String) = conn
        .query_row(
            "SELECT root_board_id, title FROM workspaces LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(title, "Home");

    // The root board must be the one referenced by the workspace.
    let home_title: String = conn
        .query_row(
            "SELECT title FROM boards WHERE id = ?1",
            [&root_board_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(home_title, "Home");

    // A view-state row must exist for the Home board.
    let view_state_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM board_view_states WHERE board_id = ?1",
            [&root_board_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(view_state_count, 1, "Home must have a view-state row");
}

#[test]
fn bootstrap_is_idempotent() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();

    let workspace_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
        .unwrap();
    assert_eq!(workspace_count, 1);

    let board_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM boards", [], |r| r.get(0))
        .unwrap();
    assert_eq!(board_count, 1);

    // Idempotent bootstrap must not duplicate the view-state row.
    let view_state_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM board_view_states", [], |r| r.get(0))
        .unwrap();
    assert_eq!(view_state_count, 1);
}

#[test]
fn bootstrap_backfills_missing_home_view_state() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();

    // Simulate a legacy database: drop the view-state row, then re-bootstrap.
    conn.execute("DELETE FROM board_view_states", []).unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();

    let view_state_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM board_view_states", [], |r| r.get(0))
        .unwrap();
    assert_eq!(view_state_count, 1, "backfill must recreate the view state");
}
