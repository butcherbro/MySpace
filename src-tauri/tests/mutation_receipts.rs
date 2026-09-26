//! P1.5: card-level writes return typed receipts carrying the revision SQLite
//! stored, and every derived plain-text column is computed by the backend
//! codec from the document JSON (the caller cannot supply it).

use myspace_lib::app::{Workspace, WorkspacePaths};
use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::models::{
    CardReceipt, ConvertNoteToEmbedInput, CreateImageCardInput, CreateLinkBatchInput,
    CreateNoteInput, Frame, LinkBatchItem, MoveCardItem, MoveCardToBoardInput,
    MoveCardToUnsortedItem, MoveCardsInput, MoveCardsToUnsortedInput, PlaceUnsortedCardInput,
    TextReceipt, UpdateCardFrameInput, UpdateEmbedDescriptionInput, UpdateImageCaptionInput,
    UpdateNoteInput, UpdateViewportInput, ViewportReceipt,
};
use myspace_lib::domain::mutation::Mutation;
use myspace_lib::domain::plain_text::document_to_plain_text;
use myspace_lib::repositories::workspace_repository as repo;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

fn setup() -> (Connection, String) {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = conn
        .query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    (conn, home)
}

fn frame(x: f64) -> Frame {
    Frame {
        x,
        y: 0.0,
        width: 200.0,
        height: 80.0,
    }
}

/// A document whose plain text is not a trivial copy of one string: a
/// heading, a list and a hard break.
fn rich_doc(tag: &str) -> Value {
    json!({
        "type": "doc",
        "content": [
            { "type": "heading", "attrs": { "level": 2 }, "content": [{ "type": "text", "text": tag }] },
            { "type": "bulletList", "content": [
                { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "one" }] }] },
                { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "two" }] }] }
            ]},
            { "type": "paragraph", "content": [
                { "type": "text", "text": "a", "marks": [{ "type": "bold" }] },
                { "type": "hardBreak" },
                { "type": "text", "text": "b" }
            ]}
        ]
    })
}

fn create_note(conn: &mut Connection, board_id: &str, id: &str, x: f64) -> CardReceipt {
    repo::create_note(
        conn,
        &CreateNoteInput {
            id: id.to_string(),
            board_id: board_id.to_string(),
            frame: frame(x),
            z_index: 0,
            document_json: rich_doc(id),
        },
    )
    .unwrap()
}

fn stored(conn: &Connection, sql: &str, id: &str) -> String {
    conn.query_row(sql, [id], |r| r.get(0)).unwrap()
}

fn revision(conn: &Connection, id: &str) -> i64 {
    conn.query_row("SELECT revision FROM cards WHERE id = ?1", [id], |r| {
        r.get(0)
    })
    .unwrap()
}

fn insert_asset(conn: &Connection, id: &str) {
    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at)
         VALUES (?1, ?2, 'image/png', ?2, 64, 32, 10, 0)",
        params![id, format!("{id}.png")],
    )
    .unwrap();
}

fn convert_to_embed(conn: &mut Connection, id: &str, expected_revision: i64) {
    repo::convert_note_to_embed(
        conn,
        &ConvertNoteToEmbedInput {
            id: id.to_string(),
            expected_revision,
            source_url: "https://example.com".into(),
            display_url: "example.com".into(),
            title: "Example".into(),
            description_json: rich_doc("desc"),
        },
    )
    .unwrap();
}

// ---- receipts --------------------------------------------------------------

#[test]
fn create_note_receipt_carries_revision_one() {
    let (mut conn, home) = setup();
    let receipt = create_note(&mut conn, &home, "n1", 0.0);
    assert_eq!(
        receipt,
        CardReceipt {
            id: "n1".into(),
            revision: 1
        }
    );
}

#[test]
fn update_note_receipts_follow_the_stored_revision() {
    let (mut conn, home) = setup();
    create_note(&mut conn, &home, "n1", 0.0);

    let update = |conn: &mut Connection, expected_revision: i64, text: &str| {
        repo::update_note(
            conn,
            &UpdateNoteInput {
                id: "n1".into(),
                expected_revision,
                document_json: json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]}),
                acknowledge_corrupt: false,
            },
        )
        .unwrap()
    };
    let first = update(&mut conn, 1, "v2");
    assert_eq!(
        first,
        TextReceipt {
            id: "n1".into(),
            revision: 2,
            plain_text: "v2".into()
        }
    );
    let second = update(&mut conn, first.revision, "v3");
    assert_eq!(second.revision, 3);
    assert_eq!(second.plain_text, "v3");
    assert_eq!(revision(&conn, "n1"), 3);
}

#[test]
fn move_card_and_place_unsorted_receipts_carry_the_stored_revision() {
    let (mut conn, home) = setup();
    create_note(&mut conn, &home, "n1", 0.0);

    let moved = repo::update_card_frame(
        &mut conn,
        &UpdateCardFrameInput {
            id: "n1".into(),
            expected_revision: 1,
            frame: frame(50.0),
        },
    )
    .unwrap();
    assert_eq!(moved.revision, 2);
    assert_eq!(moved.id, "n1");

    let unsorted = repo::move_cards_to_board_unsorted(
        &mut conn,
        &MoveCardsToUnsortedInput {
            target_board_id: home.clone(),
            cards: vec![MoveCardToUnsortedItem {
                id: "n1".into(),
                expected_revision: moved.revision,
            }],
        },
    )
    .unwrap();
    assert_eq!(
        unsorted.cards,
        vec![CardReceipt {
            id: "n1".into(),
            revision: 3
        }]
    );

    let placed = repo::place_unsorted_card(
        &mut conn,
        &PlaceUnsortedCardInput {
            id: "n1".into(),
            expected_revision: 3,
            frame: frame(10.0),
        },
    )
    .unwrap();
    assert_eq!(placed.revision, 4);
    assert_eq!(revision(&conn, "n1"), 4);
}

#[test]
fn move_cards_returns_one_receipt_per_card_in_input_order() {
    let (mut conn, home) = setup();
    create_note(&mut conn, &home, "a", 0.0);
    create_note(&mut conn, &home, "b", 300.0);
    // Give "b" a different starting revision so the receipts cannot be a
    // constant.
    repo::update_card_frame(
        &mut conn,
        &UpdateCardFrameInput {
            id: "b".into(),
            expected_revision: 1,
            frame: frame(310.0),
        },
    )
    .unwrap();

    let receipt = repo::move_cards(
        &mut conn,
        &MoveCardsInput {
            cards: vec![
                MoveCardItem {
                    id: "b".into(),
                    expected_revision: 2,
                    frame: frame(400.0),
                },
                MoveCardItem {
                    id: "a".into(),
                    expected_revision: 1,
                    frame: frame(20.0),
                },
            ],
        },
    )
    .unwrap();
    assert_eq!(
        receipt.cards,
        vec![
            CardReceipt {
                id: "b".into(),
                revision: 3
            },
            CardReceipt {
                id: "a".into(),
                revision: 2
            },
        ]
    );
}

#[test]
fn move_card_to_board_receipt_carries_the_stored_revision() {
    let (mut conn, home) = setup();
    create_note(&mut conn, &home, "n1", 0.0);
    myspace_lib::domain::board_service::create_child_board(
        &mut conn,
        &myspace_lib::domain::models::CreateChildBoardInput {
            parent_board_id: home.clone(),
            board_id: "child".into(),
            portal_card_id: "portal".into(),
            frame: frame(500.0),
            title: "Child".into(),
        },
    )
    .unwrap();

    let receipt = repo::move_card_to_board(
        &mut conn,
        &MoveCardToBoardInput {
            id: "n1".into(),
            expected_revision: 1,
            target_board_id: "child".into(),
            frame: None,
        },
    )
    .unwrap();
    assert_eq!(
        receipt,
        CardReceipt {
            id: "n1".into(),
            revision: 2
        }
    );
}

#[test]
fn save_viewport_receipts_follow_the_stored_revision() {
    let (mut conn, home) = setup();
    let current: i64 = conn
        .query_row(
            "SELECT revision FROM board_view_states WHERE board_id = ?1",
            [home.as_str()],
            |r| r.get(0),
        )
        .unwrap();
    let save = |conn: &mut Connection, expected_revision: i64| {
        repo::update_viewport(
            conn,
            &UpdateViewportInput {
                board_id: home.clone(),
                expected_revision,
                x: 1.0,
                y: 2.0,
                zoom: 1.5,
            },
        )
        .unwrap()
    };
    let first = save(&mut conn, current);
    assert_eq!(
        first,
        ViewportReceipt {
            revision: current + 1
        }
    );
    let second = save(&mut conn, first.revision);
    assert_eq!(second.revision, current + 2);
}

#[test]
fn receipts_travel_through_the_mutation_funnel() {
    let dir = std::env::temp_dir().join(format!("myspace-receipts-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).unwrap();
    let ws = Workspace::open(WorkspacePaths::new(dir)).unwrap();
    let home = ws
        .read_blocking(|conn| repo::load_home_board(conn).map(|b| b.id))
        .unwrap();

    let created = ws
        .apply_blocking(Mutation::CreateNote(CreateNoteInput {
            id: "n1".into(),
            board_id: home.clone(),
            frame: frame(0.0),
            z_index: 0,
            document_json: rich_doc("n1"),
        }))
        .unwrap()
        .into_card_receipt()
        .unwrap();
    assert_eq!(created.revision, 1);

    let updated = ws
        .apply_blocking(Mutation::UpdateNote(UpdateNoteInput {
            id: "n1".into(),
            expected_revision: created.revision,
            document_json: rich_doc("again"),
            acknowledge_corrupt: false,
        }))
        .unwrap()
        .into_text_receipt()
        .unwrap();
    assert_eq!(updated.revision, 2);
    assert_eq!(
        updated.plain_text,
        document_to_plain_text(&rich_doc("again"))
    );

    let moved = ws
        .apply_blocking(Mutation::MoveCards(MoveCardsInput {
            cards: vec![MoveCardItem {
                id: "n1".into(),
                expected_revision: 2,
                frame: frame(9.0),
            }],
        }))
        .unwrap()
        .into_cards_receipt()
        .unwrap();
    assert_eq!(moved.cards[0].revision, 3);
}

// ---- derived plain text ----------------------------------------------------

#[test]
fn note_plain_text_is_derived_from_the_document() {
    let (mut conn, home) = setup();
    create_note(&mut conn, &home, "n1", 0.0);
    let sql = "SELECT plain_text FROM note_cards WHERE card_id = ?1";
    assert_eq!(stored(&conn, sql, "n1"), "n1\n• one\n• two\na\nb");
    assert_eq!(
        stored(&conn, sql, "n1"),
        document_to_plain_text(&rich_doc("n1"))
    );

    let receipt = repo::update_note(
        &mut conn,
        &UpdateNoteInput {
            id: "n1".into(),
            expected_revision: 1,
            document_json: rich_doc("edited"),
            acknowledge_corrupt: false,
        },
    )
    .unwrap();
    assert_eq!(stored(&conn, sql, "n1"), receipt.plain_text);
    assert_eq!(
        receipt.plain_text,
        document_to_plain_text(&rich_doc("edited"))
    );
}

#[test]
fn caption_plain_text_is_derived_from_the_caption_document() {
    let (mut conn, home) = setup();
    insert_asset(&conn, "asset-1");
    repo::create_image_card(
        &mut conn,
        &CreateImageCardInput {
            id: "img".into(),
            board_id: home,
            frame: frame(0.0),
            z_index: 0,
            asset_id: "asset-1".into(),
            caption_json: rich_doc("cap"),
        },
    )
    .unwrap();
    let sql = "SELECT caption_plain_text FROM image_cards WHERE card_id = ?1";
    assert_eq!(
        stored(&conn, sql, "img"),
        document_to_plain_text(&rich_doc("cap"))
    );

    let receipt = repo::update_image_caption(
        &mut conn,
        &UpdateImageCaptionInput {
            id: "img".into(),
            expected_revision: 1,
            caption_json: rich_doc("new caption"),
            acknowledge_corrupt: false,
        },
    )
    .unwrap();
    assert_eq!(receipt.revision, 2);
    assert_eq!(
        receipt.plain_text,
        document_to_plain_text(&rich_doc("new caption"))
    );
    assert_eq!(stored(&conn, sql, "img"), receipt.plain_text);
}

#[test]
fn description_plain_text_is_derived_on_convert_and_update() {
    let (mut conn, home) = setup();
    create_note(&mut conn, &home, "n1", 0.0);
    convert_to_embed(&mut conn, "n1", 1);
    let sql = "SELECT description_plain_text FROM embed_cards WHERE card_id = ?1";
    assert_eq!(
        stored(&conn, sql, "n1"),
        document_to_plain_text(&rich_doc("desc"))
    );

    let receipt = repo::update_embed_description(
        &mut conn,
        &UpdateEmbedDescriptionInput {
            id: "n1".into(),
            expected_revision: 2,
            description_json: rich_doc("comment"),
            acknowledge_corrupt: false,
        },
    )
    .unwrap();
    assert_eq!(receipt.revision, 3);
    assert_eq!(
        receipt.plain_text,
        document_to_plain_text(&rich_doc("comment"))
    );
    assert_eq!(stored(&conn, sql, "n1"), receipt.plain_text);
}

#[test]
fn link_batch_description_is_derived_through_the_codec() {
    let (mut conn, home) = setup();
    repo::create_link_batch(
        &mut conn,
        &CreateLinkBatchInput {
            idempotency_key: "k".into(),
            board_id: home,
            links: vec![
                LinkBatchItem {
                    id: "l1".into(),
                    source_url: "https://a.example".into(),
                    title: "A".into(),
                    description: "  a user comment  ".into(),
                },
                LinkBatchItem {
                    id: "l2".into(),
                    source_url: "https://b.example".into(),
                    title: "B".into(),
                    description: String::new(),
                },
            ],
        },
    )
    .unwrap();
    let text = "SELECT description_plain_text FROM embed_cards WHERE card_id = ?1";
    let doc = "SELECT description_json FROM embed_cards WHERE card_id = ?1";
    for id in ["l1", "l2"] {
        let stored_doc: Value = serde_json::from_str(&stored(&conn, doc, id)).unwrap();
        assert_eq!(stored(&conn, text, id), document_to_plain_text(&stored_doc));
    }
    assert_eq!(stored(&conn, text, "l1"), "a user comment");
    assert_eq!(stored(&conn, text, "l2"), "");
}
