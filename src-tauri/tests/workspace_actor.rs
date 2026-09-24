//! P1.1 acceptance: the `Workspace` handle serialises writes on one thread,
//! serves reads from a pool, and never surfaces "database is locked" to a
//! caller when another *process* (simulated here by a second raw connection)
//! briefly holds the write lock.

use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use myspace_lib::app::{Workspace, WorkspacePaths};
use myspace_lib::db;
use myspace_lib::domain::models::{CreateNoteInput, Frame};
use myspace_lib::domain::mutation::{Mutation, MutationOutcome};
use myspace_lib::repositories::workspace_repository;
use rusqlite::TransactionBehavior;

fn temp_workspace(tag: &str) -> Workspace {
    let dir = std::env::temp_dir().join(format!("myspace-actor-{}-{}", tag, uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).unwrap();
    Workspace::open(WorkspacePaths::new(dir)).expect("workspace opens")
}

fn home_id(ws: &Workspace) -> String {
    ws.read_blocking(|conn| workspace_repository::load_home_board(conn).map(|b| b.id))
        .unwrap()
}

fn note(board_id: &str, n: usize) -> Mutation {
    Mutation::CreateNote(CreateNoteInput {
        id: uuid::Uuid::now_v7().to_string(),
        board_id: board_id.to_string(),
        frame: Frame {
            x: n as f64 * 10.0,
            y: 0.0,
            width: 200.0,
            height: 80.0,
        },
        z_index: n as i64,
        document_json: serde_json::json!({ "type": "doc" }),
        plain_text: format!("note {n}"),
    })
}

#[test]
fn writes_are_applied_and_visible_to_pooled_readers() {
    let ws = temp_workspace("basic");
    let home = home_id(&ws);
    for n in 0..5 {
        ws.apply_blocking(note(&home, n))
            .unwrap()
            .into_unit()
            .unwrap();
    }
    let count: i64 = ws
        .read_blocking(|conn| {
            conn.query_row("SELECT COUNT(*) FROM cards WHERE kind = 'note'", [], |r| {
                r.get(0)
            })
            .map_err(Into::into)
        })
        .unwrap();
    assert_eq!(count, 5);
}

#[test]
fn concurrent_callers_share_one_writer_and_never_see_database_locked() {
    let ws = Arc::new(temp_workspace("contention"));
    let home = home_id(&ws);

    // Another process holding the write lock: a raw second connection with an
    // IMMEDIATE transaction open for longer than any single write takes, but
    // well inside busy_timeout (5 s).
    let db_path = ws.paths().db_path();
    let blocker = thread::spawn(move || {
        let mut conn = rusqlite::Connection::open(&db_path).unwrap();
        db::apply_pragmas(&conn).unwrap();
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        thread::sleep(Duration::from_millis(400));
        tx.commit().unwrap();
    });

    // Give the blocker time to acquire the lock before we start writing.
    thread::sleep(Duration::from_millis(50));

    let started = Instant::now();
    let workers: Vec<_> = (0..8)
        .map(|w| {
            let ws = Arc::clone(&ws);
            let home = home.clone();
            thread::spawn(move || {
                for n in 0..5 {
                    ws.apply_blocking(note(&home, w * 10 + n))
                        .unwrap_or_else(|e| panic!("worker {w} write {n} failed: {e}"))
                        .into_unit()
                        .unwrap();
                }
            })
        })
        .collect();
    for w in workers {
        w.join().unwrap();
    }
    blocker.join().unwrap();
    assert!(
        started.elapsed() >= Duration::from_millis(300),
        "writes must have waited for the external lock, not failed fast"
    );

    let count: i64 = ws
        .read_blocking(|conn| {
            conn.query_row("SELECT COUNT(*) FROM cards WHERE kind = 'note'", [], |r| {
                r.get(0)
            })
            .map_err(Into::into)
        })
        .unwrap();
    assert_eq!(count, 40);
}

#[test]
fn reads_are_served_while_a_write_is_queued() {
    let ws = Arc::new(temp_workspace("reads"));
    let home = home_id(&ws);
    ws.apply_blocking(note(&home, 0)).unwrap();

    // Occupy the writer with a slow external lock; reads must not wait on it.
    let db_path = ws.paths().db_path();
    let blocker = thread::spawn(move || {
        let mut conn = rusqlite::Connection::open(&db_path).unwrap();
        db::apply_pragmas(&conn).unwrap();
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        thread::sleep(Duration::from_millis(400));
        tx.commit().unwrap();
    });
    thread::sleep(Duration::from_millis(50));

    let writer = {
        let ws = Arc::clone(&ws);
        let home = home.clone();
        thread::spawn(move || ws.apply_blocking(note(&home, 1)).unwrap())
    };

    let started = Instant::now();
    let count: i64 = ws
        .read_blocking(|conn| {
            conn.query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0))
                .map_err(Into::into)
        })
        .unwrap();
    assert_eq!(count, 1);
    assert!(
        started.elapsed() < Duration::from_millis(200),
        "a WAL reader must not block behind the writer"
    );

    writer.join().unwrap();
    blocker.join().unwrap();
}

#[test]
fn outcome_mismatch_is_an_error_not_a_panic() {
    let ws = temp_workspace("outcome");
    let home = home_id(&ws);
    let outcome = ws.apply_blocking(note(&home, 0)).unwrap();
    assert!(matches!(outcome, MutationOutcome::Unit));
    let err = ws
        .apply_blocking(note(&home, 1))
        .unwrap()
        .into_id()
        .unwrap_err();
    assert!(err.to_string().contains("unexpected mutation outcome"));
}

#[tokio::test]
async fn async_api_round_trips() {
    let ws = temp_workspace("async");
    let home = ws
        .read(|conn| workspace_repository::load_home_board(conn).map(|b| b.id))
        .await
        .unwrap();
    ws.apply(note(&home, 0)).await.unwrap().into_unit().unwrap();
    let version: i64 = ws
        .inspect_writer(|conn| {
            conn.query_row("PRAGMA data_version", [], |r| r.get(0))
                .map_err(Into::into)
        })
        .await
        .unwrap();
    assert!(version >= 1);
}
