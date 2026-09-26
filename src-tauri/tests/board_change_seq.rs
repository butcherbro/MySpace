//! P1.6: `boards.change_seq` (migration 0023) moves exactly when something the
//! board renders changes, and `get_board_change_seq` pairs it with the writer
//! connection's `PRAGMA data_version`.

use myspace_lib::app::{Workspace, WorkspacePaths};
use myspace_lib::db;
use myspace_lib::domain::errors::WorkspaceError;
use myspace_lib::domain::models::{
    CreateChildBoardInput, CreateNoteInput, Frame, MoveCardToBoardInput, UpdateNoteInput,
    UpdateViewportInput,
};
use myspace_lib::domain::mutation::Mutation;
use myspace_lib::repositories::boards::{get_board_change_seq, BoardChangeSeq};
use myspace_lib::repositories::workspace_repository;

fn temp_workspace(tag: &str) -> Workspace {
    let dir = std::env::temp_dir().join(format!(
        "myspace-change-seq-{}-{}",
        tag,
        uuid::Uuid::now_v7()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    Workspace::open(WorkspacePaths::new(dir)).expect("workspace opens")
}

fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

fn frame() -> Frame {
    Frame {
        x: 0.0,
        y: 0.0,
        width: 200.0,
        height: 80.0,
    }
}

fn home_id(ws: &Workspace) -> String {
    ws.read_blocking(|conn| workspace_repository::load_home_board(conn).map(|b| b.id))
        .unwrap()
}

fn seq(ws: &Workspace, board_id: &str) -> i64 {
    let id = board_id.to_string();
    ws.read_blocking(move |conn| get_board_change_seq(conn, &id).map(|s| s.change_seq))
        .unwrap()
}

fn doc(text: &str) -> serde_json::Value {
    serde_json::json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]})
}

/// Creates a note on `board_id`; returns (card id, revision).
fn create_note(ws: &Workspace, board_id: &str) -> (String, i64) {
    let id = new_id();
    let receipt = ws
        .apply_blocking(Mutation::CreateNote(CreateNoteInput {
            id: id.clone(),
            board_id: board_id.to_string(),
            frame: frame(),
            z_index: 0,
            document_json: doc("hello"),
        }))
        .unwrap()
        .into_card_receipt()
        .unwrap();
    (id, receipt.revision)
}

fn create_child(ws: &Workspace, parent: &str, title: &str) -> String {
    let board_id = new_id();
    ws.apply_blocking(Mutation::CreateChildBoard(CreateChildBoardInput {
        parent_board_id: parent.to_string(),
        board_id: board_id.clone(),
        portal_card_id: new_id(),
        frame: frame(),
        title: title.to_string(),
    }))
    .unwrap()
    .into_unit()
    .unwrap();
    board_id
}

#[test]
fn creating_a_note_bumps_its_board() {
    let ws = temp_workspace("create");
    let home = home_id(&ws);
    let before = seq(&ws, &home);
    create_note(&ws, &home);
    assert!(seq(&ws, &home) > before);
}

#[test]
fn updating_note_text_bumps_its_board() {
    let ws = temp_workspace("update");
    let home = home_id(&ws);
    let (id, revision) = create_note(&ws, &home);
    let before = seq(&ws, &home);
    ws.apply_blocking(Mutation::UpdateNote(UpdateNoteInput {
        id,
        expected_revision: revision,
        document_json: doc("changed"),
        acknowledge_corrupt: false,
    }))
    .unwrap();
    assert!(seq(&ws, &home) > before);
}

#[test]
fn moving_a_card_between_boards_bumps_both() {
    let ws = temp_workspace("move");
    let home = home_id(&ws);
    let child = create_child(&ws, &home, "Child");
    let (id, revision) = create_note(&ws, &home);
    let (home_before, child_before) = (seq(&ws, &home), seq(&ws, &child));
    ws.apply_blocking(Mutation::MoveCardToBoard(MoveCardToBoardInput {
        id,
        expected_revision: revision,
        target_board_id: child.clone(),
        frame: Some(frame()),
    }))
    .unwrap();
    assert!(seq(&ws, &home) > home_before, "source board bumped");
    assert!(seq(&ws, &child) > child_before, "target board bumped");
}

#[test]
fn a_card_on_a_child_board_bumps_the_parent_for_portal_counts() {
    let ws = temp_workspace("counts");
    let home = home_id(&ws);
    let child = create_child(&ws, &home, "Child");
    let before = seq(&ws, &home);
    create_note(&ws, &child);
    assert!(seq(&ws, &home) > before, "portal child_card_count changed");
}

#[test]
fn renaming_a_child_board_bumps_it_and_its_parent() {
    let ws = temp_workspace("rename");
    let home = home_id(&ws);
    let child = create_child(&ws, &home, "Child");
    let (home_before, child_before) = (seq(&ws, &home), seq(&ws, &child));
    ws.apply_blocking(Mutation::RenameBoard {
        board_id: child.clone(),
        title: "Renamed".into(),
    })
    .unwrap();
    assert!(seq(&ws, &child) > child_before);
    assert!(seq(&ws, &home) > home_before);
}

#[test]
fn saving_the_viewport_does_not_bump() {
    let ws = temp_workspace("viewport");
    let home = home_id(&ws);
    let id = home.clone();
    let revision = ws
        .read_blocking(move |conn| {
            workspace_repository::load_board_snapshot(conn, &id).map(|s| s.viewport.revision)
        })
        .unwrap();
    let before = seq(&ws, &home);
    ws.apply_blocking(Mutation::SaveViewport(UpdateViewportInput {
        board_id: home.clone(),
        expected_revision: revision,
        x: 10.0,
        y: 20.0,
        zoom: 1.5,
    }))
    .unwrap()
    .into_viewport_receipt()
    .unwrap();
    assert_eq!(seq(&ws, &home), before);
}

#[test]
fn trashing_and_restoring_bump() {
    let ws = temp_workspace("trash");
    let home = home_id(&ws);
    let (id, _) = create_note(&ws, &home);
    let before = seq(&ws, &home);
    let batch_id = ws
        .apply_blocking(Mutation::TrashNote { card_id: id })
        .unwrap()
        .into_id()
        .unwrap();
    let trashed = seq(&ws, &home);
    assert!(trashed > before, "trash bumps");
    ws.apply_blocking(Mutation::RestoreTrashBatch { batch_id })
        .unwrap();
    assert!(seq(&ws, &home) > trashed, "restore bumps");
}

#[test]
fn trashing_a_child_board_bumps_it_and_its_parent() {
    let ws = temp_workspace("trash-board");
    let home = home_id(&ws);
    let child = create_child(&ws, &home, "Child");
    let (home_before, child_before) = (seq(&ws, &home), seq(&ws, &child));
    ws.apply_blocking(Mutation::TrashBoard {
        board_id: child.clone(),
    })
    .unwrap();
    assert!(seq(&ws, &child) > child_before);
    assert!(seq(&ws, &home) > home_before);
}

#[test]
fn get_board_change_seq_shape_and_not_found() {
    let ws = temp_workspace("shape");
    let home = home_id(&ws);
    let id = home.clone();
    let value: BoardChangeSeq = ws
        .read_blocking(move |conn| get_board_change_seq(conn, &id))
        .unwrap();
    assert!(value.change_seq >= 0);
    assert!(value.data_version >= 1);
    assert_eq!(
        serde_json::to_value(value).unwrap(),
        serde_json::json!({"dataVersion": value.data_version, "changeSeq": value.change_seq})
    );

    let err = ws
        .read_blocking(|conn| get_board_change_seq(conn, "no-such-board"))
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::NotFound(_)), "got {err:?}");
}

/// On the writer connection, own writes move `change_seq` but not
/// `data_version`; a commit from another connection moves both.
#[tokio::test]
async fn data_version_on_the_writer_ignores_own_writes() {
    let ws = temp_workspace("data-version");
    let home = ws
        .read(|conn| workspace_repository::load_home_board(conn).map(|b| b.id))
        .await
        .unwrap();
    let sample = |ws: &Workspace, id: String| {
        let ws = ws.clone();
        async move {
            ws.inspect_writer(move |conn| get_board_change_seq(conn, &id))
                .await
                .unwrap()
        }
    };

    let first = sample(&ws, home.clone()).await;
    ws.apply(Mutation::CreateNote(CreateNoteInput {
        id: new_id(),
        board_id: home.clone(),
        frame: frame(),
        z_index: 0,
        document_json: doc("own"),
    }))
    .await
    .unwrap();
    let own = sample(&ws, home.clone()).await;
    assert_eq!(own.data_version, first.data_version, "own write");
    assert!(own.change_seq > first.change_seq);

    // Another process (e.g. the MCP server) writes to the same board.
    let conn = rusqlite::Connection::open(ws.paths().db_path()).unwrap();
    db::apply_pragmas(&conn).unwrap();
    conn.execute(
        "UPDATE boards SET title = 'External' WHERE id = ?1",
        [home.as_str()],
    )
    .unwrap();
    drop(conn);

    let external = sample(&ws, home.clone()).await;
    assert_ne!(external.data_version, own.data_version, "external write");
    assert!(external.change_seq > own.change_seq);
}
