//! Service-layer tests: entity addressing and read/write journeys through
//! `WorkspaceService`.

use myspace_lib::app::{Workspace, WorkspacePaths};
use myspace_lib::domain::models::{CreateLinkBatchInput, CreateNoteInput, Frame, LinkBatchItem};
use myspace_lib::domain::mutation::Mutation;
use myspace_lib::services::workspace_service::{parse_address, WorkspaceService};

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "myspace-workspace-service-{}-{}",
        tag,
        uuid::Uuid::now_v7()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn open_workspace(tag: &str) -> Workspace {
    let dir = temp_dir(tag);
    Workspace::open(WorkspacePaths::new(dir)).unwrap()
}

fn root_board_id(ws: &Workspace) -> String {
    ws.read_blocking(|conn| {
        conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
            r.get(0)
        })
        .map_err(myspace_lib::domain::errors::WorkspaceError::from)
    })
    .unwrap()
}

#[test]
fn parse_address_extracts_kind_and_id() {
    assert_eq!(
        parse_address("myspace://board/abc").unwrap(),
        ("board".to_string(), "abc".to_string())
    );
    assert_eq!(
        parse_address("myspace://card/def").unwrap(),
        ("card".to_string(), "def".to_string())
    );
    assert_eq!(
        parse_address("myspace://asset/ghi").unwrap(),
        ("asset".to_string(), "ghi".to_string())
    );
}

#[test]
fn parse_address_rejects_invalid_shapes() {
    assert!(parse_address("not-an-address").is_err());
    assert!(parse_address("myspace://board/1/extra").is_err());
    assert!(parse_address("myspace://folder/x").is_err());
}

#[test]
fn list_boards_and_resolve_board_read_journey() {
    let ws = open_workspace("list-boards");
    let home = root_board_id(&ws);

    let boards = WorkspaceService::list_boards(&ws).unwrap();
    assert_eq!(boards.len(), 1);
    assert_eq!(boards[0].id, home);

    let resolved =
        WorkspaceService::resolve_board(&ws, &format!("myspace://board/{home}")).unwrap();
    assert_eq!(resolved.id, home);

    let snapshot = WorkspaceService::read_board(&ws, &format!("myspace://board/{home}")).unwrap();
    assert_eq!(snapshot.board.id, home);
}

#[test]
fn create_link_batch_write_journey_through_service() {
    let ws = open_workspace("create-link-batch");
    let home = root_board_id(&ws);

    let result = WorkspaceService::create_link_batch(
        &ws,
        &CreateLinkBatchInput {
            idempotency_key: "service-req-1".to_string(),
            board_id: home.clone(),
            links: vec![
                LinkBatchItem {
                    id: "s1".to_string(),
                    source_url: "https://a.com".to_string(),
                    title: "A".to_string(),
                    description: "".to_string(),
                },
                LinkBatchItem {
                    id: "s2".to_string(),
                    source_url: "https://b.com".to_string(),
                    title: "B".to_string(),
                    description: "".to_string(),
                },
            ],
        },
    )
    .unwrap();

    assert_eq!(result.card_ids.len(), 2);

    // Read back: the board now contains the two embed cards.
    let snapshot = WorkspaceService::read_board(&ws, &home).unwrap();
    assert_eq!(snapshot.cards.len(), 2);
}

#[test]
fn trash_link_batch_removes_all_cards_as_one_unit() {
    let ws = open_workspace("trash-link-batch");
    let home = root_board_id(&ws);

    let result = WorkspaceService::create_link_batch(
        &ws,
        &CreateLinkBatchInput {
            idempotency_key: "req-3".to_string(),
            board_id: home.clone(),
            links: vec![
                LinkBatchItem {
                    id: "t1".to_string(),
                    source_url: "https://a.com".to_string(),
                    title: "A".to_string(),
                    description: "".to_string(),
                },
                LinkBatchItem {
                    id: "t2".to_string(),
                    source_url: "https://b.com".to_string(),
                    title: "B".to_string(),
                    description: "".to_string(),
                },
            ],
        },
    )
    .unwrap();

    let trash_batch_id = WorkspaceService::trash_link_batch(&ws, &result.batch_id).unwrap();
    assert!(!trash_batch_id.is_empty());

    // Both cards are now trashed.
    let active: i64 = ws
        .read_blocking(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM cards WHERE kind = 'embed' AND deleted_at IS NULL",
                [],
                |r| r.get(0),
            )
            .map_err(myspace_lib::domain::errors::WorkspaceError::from)
        })
        .unwrap();
    assert_eq!(active, 0);
    let trashed: i64 = ws
        .read_blocking(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM cards WHERE kind = 'embed' AND deleted_at IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .map_err(myspace_lib::domain::errors::WorkspaceError::from)
        })
        .unwrap();
    assert_eq!(trashed, 2);
}

#[test]
fn trash_link_batch_rejects_unknown_batch() {
    let ws = open_workspace("trash-link-batch-unknown");

    let result = WorkspaceService::trash_link_batch(&ws, "does-not-exist");
    assert!(matches!(
        result,
        Err(myspace_lib::domain::errors::WorkspaceError::NotFound(_))
    ));
}

#[test]
fn read_card_resolves_card_address_back_to_content() {
    let ws = open_workspace("read-card");
    let home = root_board_id(&ws);

    ws.apply_blocking(Mutation::CreateNote(CreateNoteInput {
        id: "note-1".to_string(),
        board_id: home.clone(),
        frame: Frame {
            x: 10.0,
            y: 20.0,
            width: 200.0,
            height: 80.0,
        },
        z_index: 0,
        document_json: serde_json::json!({"type": "doc", "content": []}),
        plain_text: "hello".to_string(),
    }))
    .unwrap()
    .into_unit()
    .unwrap();

    // Resolve via a full myspace://card/<id> address.
    let card = WorkspaceService::read_card(&ws, "myspace://card/note-1").unwrap();
    match card {
        myspace_lib::domain::models::CardDto::Note(note) => {
            assert_eq!(note.id, "note-1");
            assert_eq!(note.board_id, home);
            assert_eq!(note.plain_text, "hello");
        }
        _ => panic!("expected a note card"),
    }

    // A bare card id works too.
    let card = WorkspaceService::read_card(&ws, "note-1").unwrap();
    assert!(matches!(
        card,
        myspace_lib::domain::models::CardDto::Note(_)
    ));

    // A board address must be rejected for a card read.
    let wrong = WorkspaceService::read_card(&ws, &format!("myspace://board/{home}"));
    assert!(wrong.is_err());
}
