//! Duplicate a Board Portal's whole subtree, recursively, in one atomic
//! transaction (todo.md №16). Covers: every card kind is copied, assets stay
//! shared (copy-in), the original is untouched, a failed call creates nothing,
//! the depth limit is enforced, and undo via the existing Trash mechanism
//! doesn't collect assets the copy still owns.

use std::fs;

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::asset_service;
use myspace_lib::domain::duplicate_board::{duplicate_board, MAX_DUPLICATE_DEPTH};
use myspace_lib::domain::models::{DuplicateBoardInput, Frame};
use myspace_lib::domain::trash_service;
use rusqlite::{params, Connection};

fn temp_asset_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("myspace-dup-{}", uuid::Uuid::now_v7()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn home_board_id(conn: &Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
}

fn insert_board(conn: &Connection, id: &str, parent: &str, title: &str) {
    conn.execute(
        "INSERT INTO boards (id, workspace_id, parent_board_id, title, color_token, symbol, cover_asset_id, revision, created_at, updated_at)
         SELECT ?1, w.id, ?2, ?3, 'terracotta', 'star', NULL, 1, 0, 0 FROM workspaces w",
        params![id, parent, title],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO board_view_states (board_id, viewport_x, viewport_y, zoom, revision, updated_at)
         VALUES (?1, 0, 0, 1, 1, 0)",
        [id],
    )
    .unwrap();
}

fn insert_portal(conn: &Connection, card_id: &str, board_id: &str, target_board_id: &str) {
    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at)
         VALUES (?1, ?2, 'board_portal', 0, 0, 120, 112, 0, 1, 0, 0)",
        params![card_id, board_id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO board_portal_cards (card_id, target_board_id) VALUES (?1, ?2)",
        params![card_id, target_board_id],
    )
    .unwrap();
}

fn insert_note(conn: &Connection, card_id: &str, board_id: &str, unsorted: bool) {
    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at, unsorted)
         VALUES (?1, ?2, 'note', 10, 20, 200, 80, 0, 1, 0, 0, ?3)",
        params![card_id, board_id, unsorted as i64],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO note_cards (card_id, document_json, plain_text, color_token) VALUES (?1, '{\"type\":\"doc\"}', 'hello', 'yellow')",
        [card_id],
    )
    .unwrap();
}

fn insert_asset(conn: &Connection, id: &str) {
    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at)
         VALUES (?1, ?2, 'image/png', ?2, NULL, NULL, 0, 0)",
        params![id, format!("{id}.png")],
    )
    .unwrap();
}

fn insert_image(conn: &Connection, card_id: &str, board_id: &str, asset_id: &str) {
    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at)
         VALUES (?1, ?2, 'image', 0, 0, 200, 150, 0, 1, 0, 0)",
        params![card_id, board_id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO image_cards (card_id, asset_id, caption_json, caption_plain_text) VALUES (?1, ?2, '{}', '')",
        params![card_id, asset_id],
    )
    .unwrap();
}

fn insert_file_card(
    conn: &Connection,
    card_id: &str,
    board_id: &str,
    asset_id: &str,
    preview_asset_id: &str,
) {
    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at)
         VALUES (?1, ?2, 'file', 0, 0, 200, 150, 0, 1, 0, 0)",
        params![card_id, board_id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO file_cards (card_id, asset_id, mime_type, preview_text, source_path, preview_asset_id)
         VALUES (?1, ?2, 'application/pdf', 'preview', '/tmp/doc.pdf', ?3)",
        params![card_id, asset_id, preview_asset_id],
    )
    .unwrap();
}

/// A "template" board (child of Home, with its own portal on Home) containing a
/// note, an unsorted note, an image (asset `img-a`), a file card (asset
/// `file-a` + preview `file-prev-a`), and a nested Board Portal to `nested`
/// (which itself has one note). Returns (home_id, template_board_id, template_portal_id).
fn template_fixture(conn: &Connection) -> (String, String, String) {
    let home = home_board_id(conn);
    insert_board(conn, "template", &home, "Template");
    insert_portal(conn, "template-portal", &home, "template");

    insert_note(conn, "t-note", "template", false);
    insert_note(conn, "t-note-unsorted", "template", true);

    insert_asset(conn, "img-a");
    insert_image(conn, "t-image", "template", "img-a");

    insert_asset(conn, "file-a");
    insert_asset(conn, "file-prev-a");
    insert_file_card(conn, "t-file", "template", "file-a", "file-prev-a");

    insert_board(conn, "nested", "template", "Nested");
    insert_portal(conn, "nested-portal", "template", "nested");
    insert_note(conn, "n-note", "nested", false);

    (home, "template".to_string(), "template-portal".to_string())
}

fn frame() -> Frame {
    Frame {
        x: 200.0,
        y: 200.0,
        width: 120.0,
        height: 112.0,
    }
}

fn board_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM boards", [], |r| r.get(0))
        .unwrap()
}

fn card_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn duplicate_copies_every_card_kind_and_recurses_into_nested_boards() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let (home, _template, _portal) = template_fixture(&conn);

    let input = DuplicateBoardInput {
        source_board_id: "template".into(),
        target_board_id: home.clone(),
        new_board_id: "template-copy".into(),
        new_portal_card_id: "template-copy-portal".into(),
        frame: frame(),
    };
    let receipt = duplicate_board(&mut conn, &input).unwrap();

    assert_eq!(receipt.new_board_id, "template-copy");
    assert_eq!(receipt.portal.id, "template-copy-portal");
    assert_eq!(receipt.portal.board_id, home);
    assert_eq!(receipt.portal.target.title, "Template copy");
    assert_eq!(receipt.portal.target.color_token, "terracotta");
    assert_eq!(receipt.portal.target.symbol.as_deref(), Some("star"));
    // The copy's counts include its own copied nested board and cards.
    assert_eq!(receipt.portal.target.child_board_count, 1);
    assert_eq!(receipt.portal.target.child_card_count, 5); // note, unsorted note, image, file, nested portal

    // The original board is completely untouched: same ids, same content.
    let original_title: String = conn
        .query_row("SELECT title FROM boards WHERE id = 'template'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(original_title, "Template");
    let original_note_exists: i64 = conn
        .query_row("SELECT COUNT(*) FROM cards WHERE id = 't-note'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(original_note_exists, 1);

    // The copy has its own note with the same content, a new id.
    let (copied_note_id, doc, plain, color): (String, String, String, String) = conn
        .query_row(
            "SELECT c.id, n.document_json, n.plain_text, n.color_token
             FROM cards c JOIN note_cards n ON n.card_id = c.id
             WHERE c.board_id = 'template-copy' AND c.unsorted = 0",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_ne!(copied_note_id, "t-note");
    assert_eq!(doc, "{\"type\":\"doc\"}");
    assert_eq!(plain, "hello");
    assert_eq!(color, "yellow");

    // The unsorted note stayed unsorted in the copy.
    let unsorted_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE board_id = 'template-copy' AND unsorted = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(unsorted_count, 1);

    // Image and file cards in the copy reference the SAME asset ids (copy-in).
    let image_asset: String = conn
        .query_row(
            "SELECT i.asset_id FROM cards c JOIN image_cards i ON i.card_id = c.id WHERE c.board_id = 'template-copy'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(image_asset, "img-a");
    let (file_asset, file_preview): (String, Option<String>) = conn
        .query_row(
            "SELECT f.asset_id, f.preview_asset_id FROM cards c JOIN file_cards f ON f.card_id = c.id WHERE c.board_id = 'template-copy'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(file_asset, "file-a");
    assert_eq!(file_preview.as_deref(), Some("file-prev-a"));

    // The nested portal was copied AND its target board was recursively duplicated.
    let (nested_copy_portal, nested_copy_target): (String, String) = conn
        .query_row(
            "SELECT c.id, p.target_board_id
             FROM cards c JOIN board_portal_cards p ON p.card_id = c.id
             WHERE c.board_id = 'template-copy'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_ne!(nested_copy_portal, "nested-portal");
    assert_ne!(nested_copy_target, "nested");
    let nested_copy_title: String = conn
        .query_row(
            "SELECT title FROM boards WHERE id = ?1",
            [&nested_copy_target],
            |r| r.get(0),
        )
        .unwrap();
    // Only the ROOT of a duplicate is renamed "... copy"; nested boards keep
    // their own title unchanged.
    assert_eq!(nested_copy_title, "Nested");
    let nested_note_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE board_id = ?1 AND kind = 'note'",
            [&nested_copy_target],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(nested_note_count, 1);

    // The original nested board is untouched too.
    let original_nested_note_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE board_id = 'nested'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(original_nested_note_count, 1);
}

#[test]
fn duplicate_names_the_copy_uniquely_among_target_siblings() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let (home, _template, _portal) = template_fixture(&conn);

    let first = duplicate_board(
        &mut conn,
        &DuplicateBoardInput {
            source_board_id: "template".into(),
            target_board_id: home.clone(),
            new_board_id: "copy-1".into(),
            new_portal_card_id: "copy-1-portal".into(),
            frame: frame(),
        },
    )
    .unwrap();
    assert_eq!(first.portal.target.title, "Template copy");

    let second = duplicate_board(
        &mut conn,
        &DuplicateBoardInput {
            source_board_id: "template".into(),
            target_board_id: home,
            new_board_id: "copy-2".into(),
            new_portal_card_id: "copy-2-portal".into(),
            frame: frame(),
        },
    )
    .unwrap();
    assert_eq!(second.portal.target.title, "Template copy 2");
}

#[test]
fn a_conflicting_new_board_id_creates_nothing_at_all() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let (home, _template, _portal) = template_fixture(&conn);

    let boards_before = board_count(&conn);
    let cards_before = card_count(&conn);

    // 'nested' already exists, so this must fail before creating anything.
    let result = duplicate_board(
        &mut conn,
        &DuplicateBoardInput {
            source_board_id: "template".into(),
            target_board_id: home,
            new_board_id: "nested".into(),
            new_portal_card_id: "will-not-exist".into(),
            frame: frame(),
        },
    );
    assert!(result.is_err());
    assert_eq!(
        board_count(&conn),
        boards_before,
        "no board was created on failure"
    );
    assert_eq!(
        card_count(&conn),
        cards_before,
        "no card was created on failure"
    );
    let portal_card_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE id = 'will-not-exist'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(portal_card_exists, 0);
}

#[test]
fn nesting_deeper_than_the_limit_is_refused() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = home_board_id(&conn);

    // Build a chain home -> b0 -> b1 -> ... -> b{N} deep enough to exceed
    // MAX_DUPLICATE_DEPTH once duplicated starting from b0.
    let mut parent = home.clone();
    let depth = MAX_DUPLICATE_DEPTH + 2;
    for i in 0..depth {
        let board_id = format!("chain-{i}");
        let portal_id = format!("chain-{i}-portal");
        insert_board(&conn, &board_id, &parent, &format!("Chain {i}"));
        insert_portal(&conn, &portal_id, &parent, &board_id);
        parent = board_id;
    }

    let result = duplicate_board(
        &mut conn,
        &DuplicateBoardInput {
            source_board_id: "chain-0".into(),
            target_board_id: home,
            new_board_id: "chain-copy".into(),
            new_portal_card_id: "chain-copy-portal".into(),
            frame: frame(),
        },
    );
    match result {
        Err(myspace_lib::domain::errors::WorkspaceError::ConstraintViolation(message)) => {
            assert!(message.contains("depth"), "got: {message}");
        }
        other => panic!("expected a depth ConstraintViolation, got {other:?}"),
    }
    // The failed deep copy created nothing either.
    let leftover: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM boards WHERE id = 'chain-copy'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(leftover, 0);
}

#[test]
fn undo_via_trash_removes_the_copy_and_restore_brings_it_all_back() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let (home, _template, _portal) = template_fixture(&conn);

    let receipt = duplicate_board(
        &mut conn,
        &DuplicateBoardInput {
            source_board_id: "template".into(),
            target_board_id: home,
            new_board_id: "template-copy".into(),
            new_portal_card_id: "template-copy-portal".into(),
            frame: frame(),
        },
    )
    .unwrap();

    // Undo: trash the whole new subtree the same way deleting any portal does.
    let batch_id = trash_service::trash_board(&mut conn, &receipt.new_board_id).unwrap();

    let active_after_trash: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM boards WHERE id = 'template-copy' AND deleted_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(active_after_trash, 0);

    // GC must not collect the shared assets: the ORIGINAL still owns them, even
    // though the copy that also referenced them is now trashed.
    let asset_dir = temp_asset_dir();
    let collected = asset_service::collect_orphaned_assets(&mut conn, &asset_dir).unwrap();
    assert_eq!(
        collected, 0,
        "assets shared with the untouched original must survive GC"
    );

    // Redo (restore): everything comes back under the same ids.
    trash_service::restore_trash_batch(&mut conn, &batch_id).unwrap();
    let active_after_restore: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM boards WHERE id = 'template-copy' AND deleted_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(active_after_restore, 1);
    let nested_copy_active: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM boards WHERE parent_board_id = 'template-copy' AND deleted_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(nested_copy_active, 1, "the nested duplicate comes back too");
}

#[test]
fn missing_source_or_target_is_not_found() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = home_board_id(&conn);
    insert_board(&conn, "template", &home, "Template");
    insert_portal(&conn, "template-portal", &home, "template");

    let missing_source = duplicate_board(
        &mut conn,
        &DuplicateBoardInput {
            source_board_id: "does-not-exist".into(),
            target_board_id: home.clone(),
            new_board_id: "copy".into(),
            new_portal_card_id: "copy-portal".into(),
            frame: frame(),
        },
    );
    assert!(matches!(
        missing_source,
        Err(myspace_lib::domain::errors::WorkspaceError::NotFound(_))
    ));

    let missing_target = duplicate_board(
        &mut conn,
        &DuplicateBoardInput {
            source_board_id: "template".into(),
            target_board_id: "does-not-exist".into(),
            new_board_id: "copy".into(),
            new_portal_card_id: "copy-portal".into(),
            frame: frame(),
        },
    );
    assert!(matches!(
        missing_target,
        Err(myspace_lib::domain::errors::WorkspaceError::NotFound(_))
    ));
}
