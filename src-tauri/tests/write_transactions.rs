//! Write-transaction tests (P1.1): every write path opens `BEGIN IMMEDIATE`, so
//! a write that meets another process's open write transaction waits for
//! `busy_timeout` instead of failing with "database is locked", and every
//! check-then-act guard runs inside that transaction (after the write lock is
//! held), so the guard sees what the other writer committed.

use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use myspace_lib::db::{apply_pragmas, open_and_bootstrap};
use myspace_lib::domain::board_service;
use myspace_lib::domain::errors::WorkspaceError;
use myspace_lib::domain::models::{CreateChildBoardInput, CreateNoteInput, Frame};
use myspace_lib::repositories::workspace_repository;
use rusqlite::{Connection, TransactionBehavior};

/// How long the competing connection holds its write lock. Well under the
/// 5 s `busy_timeout`, so a waiting writer must succeed.
const HOLD: Duration = Duration::from_millis(300);

fn temp_db(tag: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("myspace-write-tx-{}-{}", tag, uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("workspace.sqlite3")
}

fn root_board_id(conn: &Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
}

fn frame() -> Frame {
    Frame {
        x: 0.0,
        y: 0.0,
        width: 120.0,
        height: 112.0,
    }
}

fn child(parent: &str, id: &str, portal: &str) -> CreateChildBoardInput {
    CreateChildBoardInput {
        parent_board_id: parent.to_string(),
        board_id: id.to_string(),
        portal_card_id: portal.to_string(),
        frame: frame(),
        title: id.to_string(),
    }
}

/// Opens a second connection to `path` (standing in for the MCP server or a
/// second app instance), takes the write lock with `BEGIN IMMEDIATE`, signals
/// that the lock is held, runs `sql` inside the held transaction, sleeps for
/// [`HOLD`], then commits.
fn hold_write_lock(
    path: PathBuf,
    sql: &'static str,
) -> (thread::JoinHandle<()>, mpsc::Receiver<()>) {
    let (locked_tx, locked_rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        let mut other = Connection::open(&path).unwrap();
        apply_pragmas(&other).unwrap();
        let tx = other
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        if !sql.is_empty() {
            tx.execute_batch(sql).unwrap();
        }
        locked_tx.send(()).unwrap();
        thread::sleep(HOLD);
        tx.commit().unwrap();
    });
    (handle, locked_rx)
}

#[test]
fn write_waits_for_another_connections_write_lock_instead_of_failing() {
    let path = temp_db("wait");
    let mut conn = open_and_bootstrap(&path).unwrap();
    let home = root_board_id(&conn);

    let (handle, locked) = hold_write_lock(path.clone(), "");
    locked.recv().unwrap();

    let started = Instant::now();
    let result = workspace_repository::create_note(
        &mut conn,
        &CreateNoteInput {
            id: uuid::Uuid::now_v7().to_string(),
            board_id: home.clone(),
            frame: frame(),
            z_index: 0,
            document_json: serde_json::json!({"type": "doc", "content": []}),
        },
    );
    let waited = started.elapsed();
    handle.join().unwrap();

    assert!(
        result.is_ok(),
        "write must wait for busy_timeout, not fail: {result:?}"
    );
    assert!(
        waited >= HOLD / 2,
        "write should have blocked on the other connection's lock (waited {waited:?})"
    );
    let notes: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE board_id = ?1 AND kind = 'note'",
            [home.as_str()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(notes, 1);
}

#[test]
fn create_child_board_guard_runs_inside_the_write_transaction() {
    let path = temp_db("guard");
    let mut conn = open_and_bootstrap(&path).unwrap();
    let home = root_board_id(&conn);
    board_service::create_child_board(&mut conn, &child(&home, "parent", "parent-portal")).unwrap();

    // The other writer trashes `parent` while holding the write lock. Our call
    // starts while the parent is still live; because its guard now runs after
    // BEGIN IMMEDIATE, it must observe the committed trash and refuse, instead
    // of inserting a live child under a trashed parent.
    let (handle, locked) = hold_write_lock(
        path.clone(),
        "UPDATE boards SET deleted_at = 1, trash_batch_id = 'other-process' WHERE id = 'parent';",
    );
    locked.recv().unwrap();

    let result =
        board_service::create_child_board(&mut conn, &child("parent", "kid", "kid-portal"));
    handle.join().unwrap();

    assert_eq!(result, Err(WorkspaceError::NotFound("parent".into())));
    let kids: i64 = conn
        .query_row("SELECT COUNT(*) FROM boards WHERE id = 'kid'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(kids, 0, "no partial rows under a trashed parent");
    let portals: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE id = 'kid-portal'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(portals, 0);
}

#[test]
fn create_child_board_error_variants_are_unchanged() {
    let path = temp_db("variants");
    let mut conn = open_and_bootstrap(&path).unwrap();
    let home = root_board_id(&conn);
    board_service::create_child_board(&mut conn, &child(&home, "a", "a-portal")).unwrap();

    // Replay with the same ids and parent: idempotent success.
    board_service::create_child_board(&mut conn, &child(&home, "a", "a-portal")).unwrap();

    // Same board id under a different parent: constraint violation.
    let conflict = board_service::create_child_board(&mut conn, &child("a", "a", "x-portal"));
    assert!(
        matches!(conflict, Err(WorkspaceError::ConstraintViolation(_))),
        "{conflict:?}"
    );

    // Trashed parent: NotFound(parent).
    myspace_lib::domain::trash_service::trash_board(&mut conn, "a").unwrap();
    let trashed = board_service::create_child_board(&mut conn, &child("a", "b", "b-portal"));
    assert_eq!(trashed, Err(WorkspaceError::NotFound("a".into())));

    // Missing parent: NotFound(parent).
    let missing = board_service::create_child_board(&mut conn, &child("nope", "c", "c-portal"));
    assert_eq!(missing, Err(WorkspaceError::NotFound("nope".into())));

    // The failed calls left no transaction open: a plain write still works.
    board_service::create_child_board(&mut conn, &child(&home, "d", "d-portal")).unwrap();
}
