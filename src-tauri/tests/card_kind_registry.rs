//! P1.3 acceptance: the card-kind registry is the single place that knows the
//! set of kinds, every kind's journal codec round-trips, and the frame bounds
//! that used to be SQL CHECKs are enforced in Rust.

use std::path::{Path, PathBuf};

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::board_service;
use myspace_lib::domain::card_kind::{handler, registry, sql_in_list, CardKind};
use myspace_lib::domain::errors::WorkspaceError;
use myspace_lib::domain::models::{
    CreateBoardShortcutInput, CreateChildBoardInput, CreateFileCardInput,
    CreateFilesystemAliasInput, CreateImageCardInput, CreateLinkBatchInput, CreateNoteInput, Frame,
    LinkBatchItem,
};
use myspace_lib::repositories::workspace_repository as repo;
use rusqlite::{params, Connection};

fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// (a) No hand-written `kind IN ('…')` list survives outside `card_kind.rs`.
#[test]
fn no_kind_in_literal_outside_card_kind() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_sources(&root, &mut files);
    assert!(
        files.len() > 10,
        "expected to scan the crate, got {files:?}"
    );
    let offenders: Vec<String> = files
        .iter()
        .filter(|path| !path.ends_with("domain/card_kind.rs"))
        .filter(|path| {
            let text = std::fs::read_to_string(path).unwrap();
            text.contains("kind IN ('") || text.contains("kind IN (\"")
        })
        .map(|path| path.display().to_string())
        .collect();
    assert!(offenders.is_empty(), "kind IN literals in {offenders:?}");
}

/// (b) `CardKind::ALL` and the registry list the same kinds in the same order.
#[test]
fn card_kind_all_matches_registry_order() {
    let registered: Vec<&str> = registry().iter().map(|h| h.kind().as_str()).collect();
    let all: Vec<&str> = CardKind::ALL.iter().map(|k| k.as_str()).collect();
    assert_eq!(registered, all);
    assert_eq!(
        CardKind::LEAF,
        CardKind::ALL
            .iter()
            .copied()
            .filter(|k| *k != CardKind::BoardPortal)
            .collect::<Vec<_>>()
            .as_slice()
    );
    assert_eq!(
        sql_in_list(CardKind::LEAF),
        "('note', 'image', 'embed', 'filesystem_alias', 'file', 'board_shortcut')"
    );
    assert!(matches!(
        "test_kind".parse::<CardKind>(),
        Err(WorkspaceError::ConstraintViolation(_))
    ));
}

fn frame() -> Frame {
    Frame {
        x: 10.0,
        y: 20.0,
        width: 240.0,
        height: 160.0,
    }
}

fn root_board(conn: &Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
}

fn insert_asset(conn: &Connection, id: &str, sha256: Option<&str>) {
    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at)
         VALUES (?1, ?2, 'image/png', ?2, 64, 32, 10, 0)",
        params![id, format!("{id}.png")],
    )
    .unwrap();
    conn.execute(
        "UPDATE assets SET sha256 = ?2 WHERE id = ?1",
        params![id, sha256],
    )
    .unwrap();
}

/// Creates one card of every kind through the existing repository/domain
/// functions and returns `(kind, card id)` pairs.
fn one_card_of_each_kind(conn: &mut Connection) -> Vec<(CardKind, String)> {
    let home = root_board(conn);
    repo::create_note(
        conn,
        &CreateNoteInput {
            id: "c-note".into(),
            board_id: home.clone(),
            frame: frame(),
            z_index: 1,
            document_json: serde_json::json!({"type": "doc", "content": [{"type": "paragraph"}]}),
            plain_text: "hello".into(),
        },
    )
    .unwrap();
    conn.execute(
        "UPDATE note_cards SET color_token = 'yellow' WHERE card_id = 'c-note'",
        [],
    )
    .unwrap();

    board_service::create_child_board(
        conn,
        &CreateChildBoardInput {
            parent_board_id: home.clone(),
            board_id: "b-child".into(),
            portal_card_id: "c-portal".into(),
            frame: frame(),
            title: "Child".into(),
        },
    )
    .unwrap();

    insert_asset(conn, "a-image", Some("ab12"));
    repo::create_image_card(
        conn,
        &CreateImageCardInput {
            id: "c-image".into(),
            board_id: home.clone(),
            frame: frame(),
            z_index: 2,
            asset_id: "a-image".into(),
            caption_json: serde_json::json!({"type": "doc"}),
            caption_plain_text: "caption".into(),
        },
    )
    .unwrap();

    let links = repo::create_link_batch(
        conn,
        &CreateLinkBatchInput {
            idempotency_key: "k-1".into(),
            board_id: home.clone(),
            links: vec![LinkBatchItem {
                id: "c-embed".into(),
                source_url: "https://example.com/".into(),
                title: "Example".into(),
                description: "A comment".into(),
            }],
        },
    )
    .unwrap();
    assert_eq!(links.card_ids, vec!["c-embed".to_string()]);
    // Give the link a preview and no favicon, to cover both LEFT JOIN shapes.
    insert_asset(conn, "a-preview", None);
    conn.execute(
        "UPDATE embed_cards SET asset_id = 'a-preview', preview_origin = 'fetched' WHERE card_id = 'c-embed'",
        [],
    )
    .unwrap();

    repo::create_filesystem_alias(
        conn,
        &CreateFilesystemAliasInput {
            id: "c-alias".into(),
            board_id: home.clone(),
            frame: frame(),
            z_index: 3,
            target_kind: "folder".into(),
            locator_blob: vec![0, 1, 2, 0xfe, 0xff],
            path_hint: "/Users/me/Documents".into(),
            display_name: "Documents".into(),
        },
    )
    .unwrap();

    insert_asset(conn, "a-file", None);
    insert_asset(conn, "a-file-preview", Some("cd34"));
    {
        let tx = conn.transaction().unwrap();
        repo::insert_file_card_rows(
            &tx,
            &CreateFileCardInput {
                id: "c-file".into(),
                board_id: home.clone(),
                frame: frame(),
                z_index: 4,
                source_path: "/tmp/notes.txt".into(),
                mime_type: "text/plain".into(),
                file_name: "notes.txt".into(),
            },
            "a-file",
            "first lines",
            Some("a-file-preview"),
        )
        .unwrap();
        tx.commit().unwrap();
    }

    repo::create_board_shortcut(
        conn,
        &CreateBoardShortcutInput {
            id: "c-shortcut".into(),
            board_id: home,
            frame: frame(),
            z_index: 5,
            target_board_id: "b-child".into(),
        },
    )
    .unwrap();

    vec![
        (CardKind::Note, "c-note".into()),
        (CardKind::BoardPortal, "c-portal".into()),
        (CardKind::Image, "c-image".into()),
        (CardKind::Embed, "c-embed".into()),
        (CardKind::FilesystemAlias, "c-alias".into()),
        (CardKind::File, "c-file".into()),
        (CardKind::BoardShortcut, "c-shortcut".into()),
    ]
}

/// (c) Every kind's journal codec round-trips its detail row exactly.
#[test]
fn every_kind_payload_round_trips() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let cards = one_card_of_each_kind(&mut conn);
    let covered: Vec<CardKind> = cards.iter().map(|(k, _)| *k).collect();
    assert_eq!(covered, CardKind::ALL, "the test must cover every kind");

    for (kind, id) in &cards {
        let h = handler(*kind);
        let original = h.load_one(&conn, id).unwrap().expect("card loads");
        assert_eq!(
            repo::load_card(&conn, id).unwrap(),
            original,
            "{kind}: load_card and load_one agree"
        );
        let payload = h.to_payload(&conn, id).unwrap();
        assert!(payload.is_object(), "{kind}: payload is an object");

        let tx = conn.transaction().unwrap();
        assert_eq!(
            h.delete_details(&tx, std::slice::from_ref(id)).unwrap(),
            1,
            "{kind}"
        );
        tx.commit().unwrap();
        assert!(
            h.load_one(&conn, id).unwrap().is_none(),
            "{kind}: the detail row is gone"
        );

        let tx = conn.transaction().unwrap();
        h.from_payload(&tx, id, &payload).unwrap();
        tx.commit().unwrap();

        let restored = h.load_one(&conn, id).unwrap().expect("card reloads");
        assert_eq!(restored, original, "{kind}: round trip changed the card");
        assert_eq!(
            h.to_payload(&conn, id).unwrap(),
            payload,
            "{kind}: payload is stable"
        );

        // Applying the same payload again is an idempotent upsert.
        let tx = conn.transaction().unwrap();
        h.from_payload(&tx, id, &payload).unwrap();
        tx.commit().unwrap();
        assert_eq!(h.load_one(&conn, id).unwrap().unwrap(), original);
    }

    let fk_violations = conn
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .query_map([], |_| Ok(()))
        .unwrap()
        .count();
    assert_eq!(fk_violations, 0);
}

#[test]
fn from_payload_rejects_a_malformed_payload() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    one_card_of_each_kind(&mut conn);
    let tx = conn.transaction().unwrap();
    let note = handler(CardKind::Note);
    assert!(matches!(
        note.from_payload(&tx, "c-note", &serde_json::json!([1, 2])),
        Err(WorkspaceError::ConstraintViolation(_))
    ));
    assert!(matches!(
        note.from_payload(&tx, "c-note", &serde_json::json!({"plain_text": "x"})),
        Err(WorkspaceError::ConstraintViolation(_))
    ));
}

#[test]
fn load_card_refuses_an_unknown_kind() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board(&conn);
    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at)
         VALUES ('c-x', ?1, 'test_kind', 0, 0, 200, 100, 0, 1, 0, 0)",
        [home.as_str()],
    )
    .unwrap();
    assert!(matches!(
        repo::load_card(&conn, "c-x"),
        Err(WorkspaceError::ConstraintViolation(_))
    ));
    // A board snapshot simply has no handler rows for it.
    let snapshot = repo::load_board_snapshot(&conn, &home).unwrap();
    assert!(snapshot.cards.is_empty());
}

/// (d) `Frame::validate` rejects exactly what the dropped CHECKs rejected.
#[test]
fn frame_validate_matches_the_old_checks() {
    let ok = |x: f64, y: f64, width: f64, height: f64| {
        Frame {
            x,
            y,
            width,
            height,
        }
        .validate()
    };
    for (w, h) in [(120.0, 48.0), (1600.0, 10000.0), (240.0, 160.0)] {
        assert!(ok(0.0, 0.0, w, h).is_ok(), "{w}x{h} is valid");
    }
    assert!(
        ok(-50.0, 1e9, 200.0, 100.0).is_ok(),
        "position is unbounded"
    );
    for (x, y, w, h) in [
        (0.0, 0.0, 119.9, 100.0),
        (0.0, 0.0, 1600.1, 100.0),
        (0.0, 0.0, 200.0, 47.9),
        (0.0, 0.0, 200.0, 10000.1),
        (0.0, 0.0, f64::NAN, 100.0),
        (0.0, 0.0, 200.0, f64::INFINITY),
        (f64::NAN, 0.0, 200.0, 100.0),
        (0.0, f64::NEG_INFINITY, 200.0, 100.0),
    ] {
        assert!(
            matches!(ok(x, y, w, h), Err(WorkspaceError::ConstraintViolation(_))),
            "({x}, {y}, {w}x{h}) must be rejected"
        );
    }
}

#[test]
fn every_frame_writer_validates() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board(&conn);
    let bad = Frame {
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 100.0,
    };
    let is_constraint =
        |r: Result<(), WorkspaceError>| matches!(r, Err(WorkspaceError::ConstraintViolation(_)));
    assert!(is_constraint(repo::create_note(
        &mut conn,
        &CreateNoteInput {
            id: "n".into(),
            board_id: home.clone(),
            frame: bad,
            z_index: 0,
            document_json: serde_json::json!({}),
            plain_text: String::new(),
        },
    )));
    assert!(is_constraint(board_service::create_child_board(
        &mut conn,
        &CreateChildBoardInput {
            parent_board_id: home.clone(),
            board_id: "b".into(),
            portal_card_id: "p".into(),
            frame: bad,
            title: "B".into(),
        },
    )));
    assert!(is_constraint(
        repo::create_board_shortcut(
            &mut conn,
            &CreateBoardShortcutInput {
                id: "s".into(),
                board_id: home.clone(),
                frame: bad,
                z_index: 0,
                target_board_id: home.clone(),
            },
        )
        .map(|_| ())
    ));
    assert!(is_constraint(repo::create_filesystem_alias(
        &mut conn,
        &CreateFilesystemAliasInput {
            id: "a".into(),
            board_id: home,
            frame: bad,
            z_index: 0,
            target_kind: "folder".into(),
            locator_blob: vec![1],
            path_hint: String::new(),
            display_name: "A".into(),
        },
    )));
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0, "nothing was written");
}
