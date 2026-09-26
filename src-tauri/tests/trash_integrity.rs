//! Regression tests for three trash data-integrity bugs:
//! 1. Trashing a board subtree must not overwrite the `trash_batch_id` of
//!    items already trashed in an earlier, separate batch.
//! 2. Restoring a batch must refuse when it would surface a card/board whose
//!    parent board is still trashed under a different batch.
//! 3. `list_trash` must sort batches newest-first *before* truncating to
//!    `MAX_BATCHES`, so the newest batches are never dropped.

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::board_service;
use myspace_lib::domain::errors::WorkspaceError;
use myspace_lib::domain::models::{CreateChildBoardInput, CreateNoteInput, Frame};
use myspace_lib::domain::trash_service;

fn root_board_id(conn: &rusqlite::Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
}

fn child_input(parent: &str, board_id: &str, portal_id: &str) -> CreateChildBoardInput {
    CreateChildBoardInput {
        parent_board_id: parent.to_string(),
        board_id: board_id.to_string(),
        portal_card_id: portal_id.to_string(),
        frame: Frame {
            x: 0.0,
            y: 0.0,
            width: 120.0,
            height: 112.0,
        },
        title: "Child".to_string(),
    }
}

fn note_input(board_id: &str, id: &str, plain_text: &str) -> CreateNoteInput {
    CreateNoteInput {
        id: id.to_string(),
        board_id: board_id.to_string(),
        frame: Frame {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 80.0,
        },
        z_index: 0,
        document_json: serde_json::json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": plain_text}]}]}),
    }
}

fn card_batch(conn: &rusqlite::Connection, card_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT trash_batch_id FROM cards WHERE id = ?1",
        [card_id],
        |r| r.get(0),
    )
    .unwrap()
}

fn card_deleted(conn: &rusqlite::Connection, card_id: &str) -> bool {
    conn.query_row(
        "SELECT deleted_at IS NOT NULL FROM cards WHERE id = ?1",
        [card_id],
        |r| r.get(0),
    )
    .unwrap()
}

fn board_batch(conn: &rusqlite::Connection, board_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT trash_batch_id FROM boards WHERE id = ?1",
        [board_id],
        |r| r.get(0),
    )
    .unwrap()
}

// --- Bug 1: trashing a subtree must not steal already-trashed items' batches ---

#[test]
fn trashing_board_does_not_reassign_already_trashed_notes_batch() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    board_service::create_child_board(&mut conn, &child_input(&home, "b1", "p1")).unwrap();
    workspace_note(&mut conn, "b1", "note-a");

    // Trash note-a first, under batch 1.
    let batch1 = trash_service::trash_note(&mut conn, "note-a").unwrap();
    assert_eq!(card_batch(&conn, "note-a"), Some(batch1.clone()));

    // Now trash the whole board b1 (which contains note-a), under batch 2.
    let batch2 = trash_service::trash_board(&mut conn, "b1").unwrap();
    assert_ne!(batch1, batch2);

    // note-a must still carry batch 1, not have been overwritten with batch 2.
    assert_eq!(
        card_batch(&conn, "note-a"),
        Some(batch1.clone()),
        "already-trashed note must keep its own batch id"
    );

    // Restoring batch 2 (the board) must NOT resurrect note-a.
    trash_service::restore_trash_batch(&mut conn, &batch2).unwrap();
    assert!(
        card_deleted(&conn, "note-a"),
        "note-a must stay trashed after restoring the unrelated board batch"
    );
    assert_eq!(card_batch(&conn, "note-a"), Some(batch1.clone()));

    // Restoring batch 1 must bring note-a back.
    trash_service::restore_trash_batch(&mut conn, &batch1).unwrap();
    assert!(!card_deleted(&conn, "note-a"), "note-a becomes active");
}

#[test]
fn trashing_ancestor_board_does_not_reassign_already_trashed_subboards_batch() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    // home -> b1 -> b2
    board_service::create_child_board(&mut conn, &child_input(&home, "b1", "p1")).unwrap();
    board_service::create_child_board(&mut conn, &child_input("b1", "b2", "p2")).unwrap();
    workspace_note(&mut conn, "b2", "note-b2");

    // Trash b2 first (batch 1) — b2 and note-b2 are trashed under batch 1.
    let batch1 = trash_service::trash_board(&mut conn, "b2").unwrap();
    assert_eq!(board_batch(&conn, "b2"), Some(batch1.clone()));
    assert_eq!(card_batch(&conn, "note-b2"), Some(batch1.clone()));

    // Now trash b1 (its parent), batch 2. The CTE walks through b2 (already
    // trashed) but must not touch it.
    let batch2 = trash_service::trash_board(&mut conn, "b1").unwrap();

    assert_eq!(
        board_batch(&conn, "b2"),
        Some(batch1.clone()),
        "already-trashed sub-board must keep its own batch id"
    );
    assert_eq!(
        card_batch(&conn, "note-b2"),
        Some(batch1.clone()),
        "cards under an already-trashed sub-board must keep their own batch id"
    );

    // Restoring batch 2 (b1) must not resurrect b2 / note-b2.
    trash_service::restore_trash_batch(&mut conn, &batch2).unwrap();
    let b2_deleted: bool = conn
        .query_row(
            "SELECT deleted_at IS NOT NULL FROM boards WHERE id = 'b2'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(b2_deleted, "b2 must stay trashed after restoring batch 2");
    assert!(card_deleted(&conn, "note-b2"));
}

fn workspace_note(conn: &mut rusqlite::Connection, board_id: &str, id: &str) {
    myspace_lib::repositories::workspace_repository::create_note(
        conn,
        &note_input(board_id, id, "hello"),
    )
    .unwrap();
}

// --- Bug 2: restore must refuse when parent board is trashed elsewhere ---

#[test]
fn restore_batch_refuses_when_cards_parent_board_trashed_in_other_batch() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    board_service::create_child_board(&mut conn, &child_input(&home, "b1", "p1")).unwrap();
    workspace_note(&mut conn, "b1", "note-a");

    // Trash the board first (batch 1), then trash a note under it directly by
    // resurrecting... instead: create a second note added after, trashed alone.
    // We need a note whose board is trashed under a *different* batch than the
    // note's own batch. Simplest: trash b1 (batch 1) which also trashes
    // note-a under batch 1. That's the *same* batch, not what we want.
    //
    // To get a genuinely different batch, restore b1, then directly mark
    // note-a as trashed under its own batch while the board is trashed under
    // another. We simulate the "orphaned" state directly since normal trashing
    // never produces it (trash_board always trashes cards under the same
    // batch as their board) — this is exactly the ambiguous state restore
    // must guard against, e.g. produced by process crashes or older buggy code
    // (bug 1, pre-fix).
    let board_batch_id = trash_service::trash_board(&mut conn, "b1").unwrap();
    // Manually give note-a a distinct batch id (simulating the previously
    // possible bad state where a batch nested inside a trashed board exists).
    conn.execute(
        "UPDATE cards SET trash_batch_id = 'other-batch' WHERE id = 'note-a'",
        [],
    )
    .unwrap();

    let result = trash_service::restore_trash_batch(&mut conn, "other-batch");
    assert!(matches!(
        result,
        Err(WorkspaceError::ConstraintViolation(_))
    ));
    // Board batch is untouched and can still be restored on its own.
    trash_service::restore_trash_batch(&mut conn, &board_batch_id).unwrap();
}

#[test]
fn restore_batch_refuses_when_boards_parent_board_trashed_in_other_batch() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    // home -> b1 -> b2
    board_service::create_child_board(&mut conn, &child_input(&home, "b1", "p1")).unwrap();
    board_service::create_child_board(&mut conn, &child_input("b1", "b2", "p2")).unwrap();

    let batch1 = trash_service::trash_board(&mut conn, "b1").unwrap();
    // Simulate b2 ending up under a distinct batch id from its trashed parent
    // b1 (the exact ambiguous state restore must refuse).
    conn.execute(
        "UPDATE boards SET trash_batch_id = 'other-board-batch' WHERE id = 'b2'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE cards SET trash_batch_id = 'other-board-batch' WHERE id = 'p2'",
        [],
    )
    .unwrap();

    let result = trash_service::restore_trash_batch(&mut conn, "other-board-batch");
    assert!(matches!(
        result,
        Err(WorkspaceError::ConstraintViolation(_))
    ));

    trash_service::restore_trash_batch(&mut conn, &batch1).unwrap();
}

#[test]
fn restore_batch_succeeds_when_parent_trashed_in_same_batch() {
    // Happy-path sanity check: the ordinary subtree-trash-then-restore case
    // (parent and child trashed together) must keep working.
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    board_service::create_child_board(&mut conn, &child_input(&home, "b1", "p1")).unwrap();
    board_service::create_child_board(&mut conn, &child_input("b1", "b2", "p2")).unwrap();
    workspace_note(&mut conn, "b2", "note-b2");

    let batch = trash_service::trash_board(&mut conn, "b1").unwrap();
    trash_service::restore_trash_batch(&mut conn, &batch).unwrap();

    let b2_deleted: bool = conn
        .query_row(
            "SELECT deleted_at IS NOT NULL FROM boards WHERE id = 'b2'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!b2_deleted);
    assert!(!card_deleted(&conn, "note-b2"));
}

// --- Bug 3: list_trash must sort before truncating ---

#[test]
fn list_trash_keeps_newest_batches_when_over_the_cap() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);

    // Create 105 single-note batches with strictly increasing deleted_at so
    // ordering is unambiguous, then verify the newest one survives the
    // MAX_BATCHES=100 cap.
    let total = 105;
    let mut batch_ids = Vec::with_capacity(total);
    for i in 0..total {
        let note_id = format!("note-{i}");
        workspace_note(&mut conn, &home, &note_id);
        let batch_id = trash_service::trash_note(&mut conn, &note_id).unwrap();
        // Force distinct, strictly increasing deleted_at (and updated_at) so
        // batch i is always newer than batch i-1, independent of wall-clock
        // resolution.
        conn.execute(
            "UPDATE cards SET deleted_at = ?1 WHERE trash_batch_id = ?2",
            rusqlite::params![1000 + i as i64, batch_id],
        )
        .unwrap();
        batch_ids.push(batch_id);
    }

    let newest_batch = batch_ids.last().unwrap().clone();
    let oldest_batch = batch_ids.first().unwrap().clone();

    let summary = trash_service::list_trash(&conn).unwrap();
    assert_eq!(summary.batches.len(), 100, "capped at MAX_BATCHES");
    assert_eq!(
        summary.batches[0].batch_id, newest_batch,
        "the newest batch must be first and must not have been dropped by truncating before sort"
    );
    assert!(
        summary.batches.iter().all(|b| b.batch_id != oldest_batch),
        "the oldest batch is the one that should be dropped once over the cap"
    );
}
