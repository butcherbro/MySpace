//! Коннекторы (стрелки между карточками доски): контракт create/update/remove,
//! валидация и правила жизненного цикла вслед за концами (корзина,
//! восстановление, Empty Trash, уход с доски, дублирование).

use myspace_lib::app::{Workspace, WorkspacePaths};
use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::errors::WorkspaceError;
use myspace_lib::domain::models::{
    ConnectorDto, CreateChildBoardInput, CreateConnectorInput, CreateNoteInput,
    DuplicateBoardInput, Frame, MoveCardToBoardInput, MoveCardToUnsortedItem,
    MoveCardsToUnsortedInput, MoveSelectionCard, MoveSelectionToBoardInput, SelectionLeafPlacement,
    TrashItem, TrashSelectionInput, UpdateConnectorInput,
};
use myspace_lib::domain::mutation::Mutation;
use myspace_lib::domain::{board_service, duplicate_board, move_selection, trash_service};
use myspace_lib::repositories::workspace_repository as repo;
use rusqlite::Connection;

fn frame(x: f64) -> Frame {
    Frame {
        x,
        y: 0.0,
        width: 200.0,
        height: 80.0,
    }
}

fn root_board_id(conn: &Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
}

fn note(conn: &mut Connection, board: &str, id: &str) {
    repo::create_note(
        conn,
        &CreateNoteInput {
            id: id.into(),
            board_id: board.into(),
            frame: frame(0.0),
            z_index: 0,
            document_json: serde_json::json!({ "type": "doc" }),
        },
    )
    .unwrap();
}

fn child_board(conn: &mut Connection, parent: &str, id: &str) {
    board_service::create_child_board(
        conn,
        &CreateChildBoardInput {
            parent_board_id: parent.into(),
            board_id: id.into(),
            portal_card_id: format!("portal-{id}"),
            frame: frame(500.0),
            title: id.into(),
        },
    )
    .unwrap();
}

fn input(id: &str, board: &str, from: &str, to: &str) -> CreateConnectorInput {
    CreateConnectorInput {
        id: id.into(),
        board_id: board.into(),
        from_card_id: from.into(),
        to_card_id: to.into(),
        color_token: None,
        arrow_ends: None,
    }
}

fn connect(conn: &mut Connection, id: &str, board: &str, from: &str, to: &str) -> ConnectorDto {
    repo::create_connector(conn, &input(id, board, from, to)).unwrap()
}

/// Home с заметками a, b, c.
fn workspace() -> (Connection, String) {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    for id in ["a", "b", "c"] {
        note(&mut conn, &home, id);
    }
    (conn, home)
}

fn shown(conn: &Connection, board: &str) -> Vec<String> {
    repo::load_board_snapshot(conn, board)
        .unwrap()
        .connectors
        .into_iter()
        .map(|c| c.id)
        .collect()
}

fn rows(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM connectors", [], |r| r.get(0))
        .unwrap()
}

fn trash_state(conn: &Connection, id: &str) -> (Option<i64>, Option<String>) {
    conn.query_row(
        "SELECT deleted_at, trash_batch_id FROM connectors WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

fn revision(conn: &Connection, card: &str) -> i64 {
    conn.query_row("SELECT revision FROM cards WHERE id = ?1", [card], |r| {
        r.get(0)
    })
    .unwrap()
}

fn is_constraint(result: Result<ConnectorDto, WorkspaceError>) -> bool {
    matches!(result, Err(WorkspaceError::ConstraintViolation(_)))
}

#[test]
fn create_returns_the_stored_row_with_defaults_and_is_idempotent() {
    let (mut conn, home) = workspace();
    let created = connect(&mut conn, "k1", &home, "a", "b");
    assert_eq!(created.board_id, home);
    assert_eq!(
        (created.from_card_id.as_str(), created.to_card_id.as_str()),
        ("a", "b")
    );
    assert_eq!(created.color_token, "default");
    assert_eq!(created.arrow_ends, "end");
    assert_eq!(created.label, None);
    assert_eq!(created.revision, 1);
    assert!(created.created_at > 0 && created.updated_at == created.created_at);

    // Тот же id с другими значениями возвращает сохранённую строку.
    let mut again = input("k1", &home, "b", "c");
    again.color_token = Some("pink".into());
    assert_eq!(repo::create_connector(&mut conn, &again).unwrap(), created);
    assert_eq!(rows(&conn), 1);

    let snapshot = repo::load_board_snapshot(&conn, &home).unwrap();
    assert_eq!(snapshot.connectors, vec![created]);
    let json = serde_json::to_value(&snapshot).unwrap();
    let wire = &json["connectors"][0];
    for key in [
        "id",
        "boardId",
        "fromCardId",
        "toCardId",
        "colorToken",
        "arrowEnds",
        "label",
        "revision",
        "createdAt",
        "updatedAt",
    ] {
        assert!(wire.get(key).is_some(), "missing {key}: {wire}");
    }
}

#[test]
fn create_validates_endpoints_board_and_tokens() {
    let (mut conn, home) = workspace();
    child_board(&mut conn, &home, "other");
    note(&mut conn, "other", "far");
    note(&mut conn, &home, "gone");
    trash_service::trash_note(&mut conn, "gone").unwrap();
    note(&mut conn, &home, "parked");
    let rev = revision(&conn, "parked");
    repo::move_cards_to_board_unsorted(
        &mut conn,
        &MoveCardsToUnsortedInput {
            target_board_id: home.clone(),
            cards: vec![MoveCardToUnsortedItem {
                id: "parked".into(),
                expected_revision: rev,
            }],
        },
    )
    .unwrap();

    let attempt = |conn: &mut Connection, i: CreateConnectorInput| repo::create_connector(conn, &i);
    assert!(
        is_constraint(attempt(&mut conn, input("x", &home, "a", "a"))),
        "self-link"
    );
    assert!(
        is_constraint(attempt(&mut conn, input("x", &home, "a", "far"))),
        "cross-board"
    );
    assert!(
        is_constraint(attempt(&mut conn, input("x", &home, "a", "parked"))),
        "unsorted"
    );
    assert!(
        is_constraint(attempt(&mut conn, input("x", &home, "gone", "a"))),
        "trashed"
    );
    assert!(
        is_constraint(attempt(&mut conn, input("x", &home, "a", "nope"))),
        "missing card"
    );
    let mut bad_color = input("x", &home, "a", "b");
    bad_color.color_token = Some("purple".into());
    assert!(is_constraint(attempt(&mut conn, bad_color)));
    let mut bad_ends = input("x", &home, "a", "b");
    bad_ends.arrow_ends = Some("start".into());
    assert!(is_constraint(attempt(&mut conn, bad_ends)));
    assert!(matches!(
        attempt(&mut conn, input("x", "no-board", "a", "b")),
        Err(WorkspaceError::NotFound(_))
    ));
    assert_eq!(rows(&conn), 0);
}

#[test]
fn update_bumps_the_revision_and_refuses_a_stale_one() {
    let (mut conn, home) = workspace();
    connect(&mut conn, "k1", &home, "a", "b");

    let update = |rev: i64| UpdateConnectorInput {
        connector_id: "k1".into(),
        expected_revision: rev,
        color_token: Some("blue".into()),
        arrow_ends: Some("both".into()),
        from_card_id: Some("b".into()),
        to_card_id: Some("a".into()),
        label: Some(Some("why".into())),
    };
    let updated = repo::update_connector(&mut conn, &update(1)).unwrap();
    assert_eq!(updated.revision, 2);
    assert_eq!(
        (updated.from_card_id.as_str(), updated.to_card_id.as_str()),
        ("b", "a")
    );
    assert_eq!(updated.color_token, "blue");
    assert_eq!(updated.arrow_ends, "both");
    assert_eq!(updated.label.as_deref(), Some("why"));

    assert_eq!(
        repo::update_connector(&mut conn, &update(1)),
        Err(WorkspaceError::StaleRevision {
            expected: 1,
            actual: 2
        })
    );

    // Отсутствующие поля не меняются; `label: null` очищает.
    let cleared = repo::update_connector(
        &mut conn,
        &serde_json::from_value(serde_json::json!({
            "connectorId": "k1", "expectedRevision": 2, "label": null
        }))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(cleared.revision, 3);
    assert_eq!(cleared.label, None);
    assert_eq!(cleared.color_token, "blue");
    assert_eq!(cleared.from_card_id, "b");

    let mut onto_self = update(3);
    onto_self.to_card_id = Some("b".into());
    assert!(is_constraint(repo::update_connector(&mut conn, &onto_self)));
    let mut bad = update(3);
    bad.color_token = Some("purple".into());
    assert!(is_constraint(repo::update_connector(&mut conn, &bad)));
    assert!(matches!(
        repo::update_connector(
            &mut conn,
            &UpdateConnectorInput {
                connector_id: "missing".into(),
                ..update(1)
            }
        ),
        Err(WorkspaceError::NotFound(_))
    ));
}

#[test]
fn remove_is_a_soft_delete_and_create_restores_it_with_its_revision() {
    let (mut conn, home) = workspace();
    connect(&mut conn, "k1", &home, "a", "b");
    let edited = repo::update_connector(
        &mut conn,
        &UpdateConnectorInput {
            connector_id: "k1".into(),
            expected_revision: 1,
            color_token: Some("blue".into()),
            arrow_ends: None,
            from_card_id: None,
            to_card_id: None,
            label: Some(Some("note".into())),
        },
    )
    .unwrap();

    repo::remove_connector(&mut conn, "k1").unwrap();
    let (deleted_at, batch) = trash_state(&conn, "k1");
    assert!(deleted_at.is_some());
    assert_eq!(batch, None);
    assert!(shown(&conn, &home).is_empty());
    assert_eq!(
        repo::load_connector(&conn, "k1").unwrap().unwrap().revision,
        edited.revision,
        "remove keeps the revision"
    );
    // Повторное удаление и неизвестный id — no-op; правка удалённого — not_found.
    repo::remove_connector(&mut conn, "k1").unwrap();
    repo::remove_connector(&mut conn, "never-existed").unwrap();
    assert!(matches!(
        repo::update_connector(
            &mut conn,
            &UpdateConnectorInput {
                connector_id: "k1".into(),
                expected_revision: edited.revision,
                color_token: None,
                arrow_ends: None,
                from_card_id: None,
                to_card_id: None,
                label: None,
            }
        ),
        Err(WorkspaceError::NotFound(_))
    ));

    // Undo удаления: create с тем же id восстанавливает строку как была.
    let mut undo = input("k1", &home, "a", "b");
    undo.color_token = Some("pink".into());
    let restored = repo::create_connector(&mut conn, &undo).unwrap();
    assert_eq!(restored.revision, edited.revision);
    assert_eq!(restored.color_token, "blue", "stored fields are kept");
    assert_eq!(restored.label.as_deref(), Some("note"));
    assert_eq!(trash_state(&conn, "k1"), (None, None));
    assert_eq!(shown(&conn, &home), ["k1"]);

    // Удалённая пользователем стрелка между живыми карточками переживает
    // Empty Trash скрытой строкой: физически её стирает только каскад.
    repo::remove_connector(&mut conn, "k1").unwrap();
    trash_service::empty_trash(&mut conn, "EMPTY").unwrap();
    assert_eq!(rows(&conn), 1);
    assert!(shown(&conn, &home).is_empty());
}

#[test]
fn removing_a_connector_trashed_with_its_endpoint_survives_that_endpoints_restore() {
    let (mut conn, home) = workspace();
    connect(&mut conn, "k1", &home, "a", "b");
    let batch = trash_service::trash_note(&mut conn, "b").unwrap();
    assert_eq!(trash_state(&conn, "k1").1, Some(batch.clone()));

    // Undo «соединить карточки», пока `b` в корзине.
    repo::remove_connector(&mut conn, "k1").unwrap();
    let (deleted_at, cleared) = trash_state(&conn, "k1");
    assert!(deleted_at.is_some());
    assert_eq!(cleared, None);

    trash_service::restore_trash_batch(&mut conn, &batch).unwrap();
    assert!(
        trash_state(&conn, "k1").0.is_some(),
        "restore does not bring it back"
    );
    assert!(shown(&conn, &home).is_empty());
}

#[test]
fn trash_note_hides_the_connector_and_restore_brings_it_back() {
    let (mut conn, home) = workspace();
    connect(&mut conn, "k1", &home, "a", "b");
    connect(&mut conn, "k2", &home, "b", "c");

    let batch = trash_service::trash_note(&mut conn, "a").unwrap();
    let card_deleted_at: i64 = conn
        .query_row("SELECT deleted_at FROM cards WHERE id = 'a'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(
        trash_state(&conn, "k1"),
        (Some(card_deleted_at), Some(batch.clone()))
    );
    assert_eq!(trash_state(&conn, "k2"), (None, None));
    assert_eq!(shown(&conn, &home), ["k2"]);

    trash_service::restore_trash_batch(&mut conn, &batch).unwrap();
    assert_eq!(trash_state(&conn, "k1"), (None, None));
    assert_eq!(shown(&conn, &home), ["k1", "k2"]);
}

#[test]
fn a_connector_restored_before_its_other_end_stays_hidden_until_both_are_back() {
    let (mut conn, home) = workspace();
    connect(&mut conn, "k1", &home, "a", "b");

    // Выделение с одним концом: коннектор уходит в тот же батч.
    let first = trash_service::trash_selection(
        &mut conn,
        &TrashSelectionInput {
            items: vec![TrashItem {
                id: "a".into(),
                kind: "note".into(),
            }],
        },
    )
    .unwrap();
    assert_eq!(trash_state(&conn, "k1").1, Some(first.clone()));
    let second = trash_service::trash_note(&mut conn, "b").unwrap();
    assert_eq!(
        trash_state(&conn, "k1").1,
        Some(first.clone()),
        "already trashed"
    );

    trash_service::restore_trash_batch(&mut conn, &first).unwrap();
    assert_eq!(trash_state(&conn, "k1"), (None, None));
    assert!(shown(&conn, &home).is_empty(), "b is still in the trash");
    trash_service::restore_trash_batch(&mut conn, &second).unwrap();
    assert_eq!(shown(&conn, &home), ["k1"]);
}

#[test]
fn trash_board_trashes_the_connectors_on_its_subtree() {
    let (mut conn, home) = workspace();
    child_board(&mut conn, &home, "child");
    note(&mut conn, "child", "x");
    note(&mut conn, "child", "y");
    connect(&mut conn, "k1", "child", "x", "y");
    connect(&mut conn, "k2", &home, "a", "portal-child");

    let batch = trash_service::trash_board(&mut conn, "child").unwrap();
    assert_eq!(trash_state(&conn, "k1").1, Some(batch.clone()));
    assert_eq!(
        trash_state(&conn, "k2").1,
        Some(batch.clone()),
        "the portal end"
    );

    trash_service::restore_trash_batch(&mut conn, &batch).unwrap();
    assert_eq!(shown(&conn, "child"), ["k1"]);
    assert_eq!(shown(&conn, &home), ["k2"]);
}

#[test]
fn empty_trash_removes_connectors_only_through_the_cascade() {
    let (mut conn, home) = workspace();
    note(&mut conn, &home, "d");
    connect(&mut conn, "k1", &home, "a", "b");
    connect(&mut conn, "k2", &home, "b", "c");
    connect(&mut conn, "k3", &home, "b", "d");
    repo::remove_connector(&mut conn, "k3").unwrap();
    // k2 жив при конце в корзине: восстановлен раньше `c`.
    let first = trash_service::trash_note(&mut conn, "b").unwrap();
    trash_service::trash_note(&mut conn, "c").unwrap();
    trash_service::restore_trash_batch(&mut conn, &first).unwrap();
    trash_service::trash_note(&mut conn, "a").unwrap();
    assert_eq!(trash_state(&conn, "k2"), (None, None));

    trash_service::empty_trash(&mut conn, "EMPTY").unwrap();
    let left: Vec<String> = conn
        .prepare("SELECT id FROM connectors ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        left,
        ["k3"],
        "k1 and k2 go with a and c by cascade; k3 joins live cards"
    );
    let violations = conn
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .query_map([], |_| Ok(()))
        .unwrap()
        .count();
    assert_eq!(violations, 0);
}

#[test]
fn a_card_moved_to_another_board_loses_its_connectors() {
    let (mut conn, home) = workspace();
    child_board(&mut conn, &home, "child");
    connect(&mut conn, "k1", &home, "a", "b");
    connect(&mut conn, "k2", &home, "b", "c");

    // Перенос на ту же доску — не уход с неё.
    let rev = revision(&conn, "a");
    repo::move_card_to_board(
        &mut conn,
        &MoveCardToBoardInput {
            id: "a".into(),
            expected_revision: rev,
            target_board_id: home.clone(),
            frame: None,
        },
    )
    .unwrap();
    assert_eq!(rows(&conn), 2);
    assert_eq!(trash_state(&conn, "k1"), (None, None));

    let rev = revision(&conn, "a");
    repo::move_card_to_board(
        &mut conn,
        &MoveCardToBoardInput {
            id: "a".into(),
            expected_revision: rev,
            target_board_id: "child".into(),
            frame: None,
        },
    )
    .unwrap();
    assert_eq!(shown(&conn, &home), ["k2"]);
    assert_eq!(rows(&conn), 2, "a soft delete");
    assert!(matches!(trash_state(&conn, "k1"), (Some(_), None)));
}

#[test]
fn a_card_moved_to_unsorted_loses_its_connectors() {
    let (mut conn, home) = workspace();
    connect(&mut conn, "k1", &home, "a", "b");
    connect(&mut conn, "k2", &home, "b", "c");
    connect(&mut conn, "k3", &home, "a", "c");
    // k2 в корзине вместе с `b`: уход `c` снимает с него батч.
    let batch = trash_service::trash_note(&mut conn, "b").unwrap();
    let rev = revision(&conn, "c");
    repo::move_cards_to_board_unsorted(
        &mut conn,
        &MoveCardsToUnsortedInput {
            target_board_id: home.clone(),
            cards: vec![MoveCardToUnsortedItem {
                id: "c".into(),
                expected_revision: rev,
            }],
        },
    )
    .unwrap();
    assert!(matches!(trash_state(&conn, "k3"), (Some(_), None)));
    assert!(matches!(trash_state(&conn, "k2"), (Some(_), None)));
    trash_service::restore_trash_batch(&mut conn, &batch).unwrap();
    assert_eq!(shown(&conn, &home), ["k1"], "k2 and k3 stay removed");
    assert_eq!(rows(&conn), 3, "soft deletes");
}

#[test]
fn a_selection_moved_to_another_board_loses_its_connectors() {
    let (mut conn, home) = workspace();
    child_board(&mut conn, &home, "child");
    connect(&mut conn, "k1", &home, "a", "b");
    connect(&mut conn, "k2", &home, "b", "c");
    let rev = revision(&conn, "a");
    move_selection::move_selection_to_board(
        &mut conn,
        &MoveSelectionToBoardInput {
            idempotency_key: "op-1".into(),
            target_board_id: "child".into(),
            cards: vec![MoveSelectionCard {
                id: "a".into(),
                expected_revision: rev,
            }],
            boards: vec![],
            leaf_placement: SelectionLeafPlacement::Unsorted,
        },
    )
    .unwrap();
    assert_eq!(shown(&conn, &home), ["k2"]);
    assert_eq!(rows(&conn), 2, "a soft delete");
    assert!(matches!(trash_state(&conn, "k1"), (Some(_), None)));
}

#[test]
fn duplicate_board_copies_connectors_with_remapped_endpoints() {
    let (mut conn, home) = workspace();
    child_board(&mut conn, &home, "src");
    note(&mut conn, "src", "x");
    note(&mut conn, "src", "y");
    let mut colored = input("k1", "src", "x", "y");
    colored.color_token = Some("green".into());
    colored.arrow_ends = Some("both".into());
    repo::create_connector(&mut conn, &colored).unwrap();

    duplicate_board::duplicate_board(
        &mut conn,
        &DuplicateBoardInput {
            source_board_id: "src".into(),
            target_board_id: home.clone(),
            new_board_id: "copy".into(),
            new_portal_card_id: "portal-copy".into(),
            frame: frame(900.0),
        },
    )
    .unwrap();

    let copies = repo::load_board_snapshot(&conn, "copy").unwrap().connectors;
    assert_eq!(copies.len(), 1);
    let copy = &copies[0];
    assert_ne!(copy.id, "k1");
    assert_eq!(copy.board_id, "copy");
    assert!(!["x", "y"].contains(&copy.from_card_id.as_str()));
    assert!(!["x", "y"].contains(&copy.to_card_id.as_str()));
    assert_ne!(copy.from_card_id, copy.to_card_id);
    assert_eq!(
        (copy.color_token.as_str(), copy.arrow_ends.as_str()),
        ("green", "both")
    );
    assert_eq!(shown(&conn, "src"), ["k1"], "the source is untouched");
}

#[test]
fn connector_writes_bump_the_boards_change_seq() {
    let (mut conn, home) = workspace();
    let seq = |conn: &Connection| -> i64 {
        conn.query_row(
            "SELECT change_seq FROM boards WHERE id = ?1",
            [&home],
            |r| r.get(0),
        )
        .unwrap()
    };
    let before = seq(&conn);
    connect(&mut conn, "k1", &home, "a", "b");
    let created = seq(&conn);
    assert!(created > before);
    repo::remove_connector(&mut conn, "k1").unwrap();
    assert!(seq(&conn) > created);
}

/// Коннектор, стёртый FK-каскадом от стираемой карточки, всё равно попадает в
/// журнал (`present: false`): SQLite запускает DELETE-триггеры на каскаде.
#[test]
fn a_cascade_deleted_connector_is_journaled_as_absent() {
    let dir = std::env::temp_dir().join(format!("myspace-connectors-{}", uuid::Uuid::now_v7()));
    let ws = Workspace::open(WorkspacePaths::new(&dir)).unwrap();
    let home: String = ws
        .read_blocking(|c| {
            Ok(c.query_row("SELECT root_board_id FROM workspaces", [], |r| r.get(0))?)
        })
        .unwrap();
    for id in ["a", "b"] {
        ws.apply_blocking(Mutation::CreateNote(CreateNoteInput {
            id: id.into(),
            board_id: home.clone(),
            frame: frame(0.0),
            z_index: 0,
            document_json: serde_json::json!({ "type": "doc" }),
        }))
        .unwrap();
    }
    ws.apply_blocking(Mutation::CreateConnector(input("k1", &home, "a", "b")))
        .unwrap()
        .into_connector()
        .unwrap();
    // k1 жив, пока `b` в корзине: Empty Trash стирает его только каскадом.
    let first = ws
        .apply_blocking(Mutation::TrashNote {
            card_id: "a".into(),
        })
        .unwrap()
        .into_id()
        .unwrap();
    ws.apply_blocking(Mutation::TrashNote {
        card_id: "b".into(),
    })
    .unwrap();
    ws.apply_blocking(Mutation::RestoreTrashBatch { batch_id: first })
        .unwrap();
    ws.apply_blocking(Mutation::EmptyTrash {
        confirmation: "EMPTY".into(),
    })
    .unwrap();

    let last: (String, String) = ws
        .read_blocking(|c| {
            Ok(c.query_row(
                "SELECT op, payload_json FROM changes
                 WHERE entity_kind = 'connector' AND entity_id = 'k1' ORDER BY hlc DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(last.0, "trash.empty");
    let payload: serde_json::Value = serde_json::from_str(&last.1).unwrap();
    assert_eq!(payload["state"], serde_json::json!({ "present": false }));
    drop(ws);
    let _ = std::fs::remove_dir_all(&dir);
}
