//! Группы на холсте (ADR-0013): create/update группы, валидация и то, что
//! группа идёт общими путями карточки-листа (корзина, перенос, Unsorted,
//! дублирование доски, коннекторы, change_seq).

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::errors::WorkspaceError;
use myspace_lib::domain::models::{
    CardDto, CreateChildBoardInput, CreateConnectorInput, CreateGroupInput, CreateNoteInput,
    DuplicateBoardInput, Frame, GroupCardDto, MoveCardToBoardInput, MoveCardToUnsortedItem,
    MoveCardsToUnsortedInput, PlaceUnsortedCardInput, TrashItem, TrashSelectionInput,
    UpdateGroupInput,
};
use myspace_lib::domain::mutation::Mutation;
use myspace_lib::domain::{board_service, duplicate_board, trash_service};
use myspace_lib::repositories::workspace_repository as repo;
use rusqlite::Connection;

fn group_frame() -> Frame {
    // Шире старого предела 1600: группа обычно больше карточек под ней.
    Frame {
        x: 0.0,
        y: 0.0,
        width: 2400.0,
        height: 900.0,
    }
}

fn root_board_id(conn: &Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
}

fn note(conn: &mut Connection, board: &str, id: &str, x: f64) {
    repo::create_note(
        conn,
        &CreateNoteInput {
            id: id.into(),
            board_id: board.into(),
            frame: Frame {
                x,
                y: 100.0,
                width: 200.0,
                height: 80.0,
            },
            z_index: 1,
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
            frame: Frame {
                x: 3000.0,
                y: 0.0,
                width: 240.0,
                height: 160.0,
            },
            title: id.into(),
        },
    )
    .unwrap();
}

fn input(id: &str, board: &str) -> CreateGroupInput {
    CreateGroupInput {
        id: id.into(),
        board_id: board.into(),
        frame: group_frame(),
        z_index: 0,
        title: None,
        color_token: None,
    }
}

fn group(card: CardDto) -> GroupCardDto {
    match card {
        CardDto::Group(g) => g,
        other => panic!("not a group: {other:?}"),
    }
}

/// Home с заметками a и b внутри будущей группы и c снаружи.
fn workspace() -> (Connection, String) {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home = root_board_id(&conn);
    note(&mut conn, &home, "a", 50.0);
    note(&mut conn, &home, "b", 400.0);
    note(&mut conn, &home, "c", 5000.0);
    (conn, home)
}

fn revision(conn: &Connection, card: &str) -> i64 {
    conn.query_row("SELECT revision FROM cards WHERE id = ?1", [card], |r| {
        r.get(0)
    })
    .unwrap()
}

fn frames(conn: &Connection, board: &str) -> Vec<(String, Frame)> {
    repo::load_board_snapshot(conn, board)
        .unwrap()
        .cards
        .into_iter()
        .filter_map(|card| match card {
            CardDto::Note(n) => Some((n.id, n.frame)),
            _ => None,
        })
        .collect()
}

fn card_ids(cards: &[CardDto]) -> Vec<&str> {
    cards.iter().map(CardDto::id).collect()
}

fn update(card_id: &str, expected_revision: i64) -> UpdateGroupInput {
    UpdateGroupInput {
        card_id: card_id.into(),
        expected_revision,
        title: None,
        color_token: None,
    }
}

#[test]
fn create_applies_defaults_and_is_idempotent_by_id() {
    let (mut conn, home) = workspace();
    let created = group(repo::create_group(&mut conn, &input("g", &home)).unwrap());
    assert_eq!(created.id, "g");
    assert_eq!(created.board_id, home);
    assert_eq!(created.frame, group_frame());
    assert_eq!(created.z_index, 0);
    assert_eq!(created.revision, 1);
    assert_eq!(created.title, "");
    assert_eq!(created.color_token, "default");

    // Повтор с другими полями возвращает сохранённую карточку, не перезаписывая.
    let mut retry = input("g", &home);
    retry.title = Some("Other".into());
    retry.color_token = Some("pink".into());
    let again = group(repo::create_group(&mut conn, &retry).unwrap());
    assert_eq!(again, created);
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM group_cards", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);

    // Чужой вид с тем же id — ошибка, а не подмена.
    assert!(matches!(
        repo::create_group(&mut conn, &input("a", &home)),
        Err(WorkspaceError::ConstraintViolation(_))
    ));
}

#[test]
fn create_stores_the_title_as_given() {
    let (mut conn, home) = workspace();
    let mut named = input("g", &home);
    named.title = Some("  Исследование  ".into());
    named.color_token = Some("blue".into());
    let created = group(repo::create_group(&mut conn, &named).unwrap());
    assert_eq!(created.title, "  Исследование  ");
    assert_eq!(created.color_token, "blue");
}

#[test]
fn create_validates_token_title_and_frame() {
    let (mut conn, home) = workspace();
    let is_constraint = |r: Result<CardDto, WorkspaceError>| {
        matches!(r, Err(WorkspaceError::ConstraintViolation(_)))
    };

    let mut bad_token = input("g1", &home);
    bad_token.color_token = Some("red".into());
    assert!(is_constraint(repo::create_group(&mut conn, &bad_token)));

    let mut long_title = input("g2", &home);
    long_title.title = Some("я".repeat(201));
    assert!(is_constraint(repo::create_group(&mut conn, &long_title)));
    // Предел в символах, не в байтах: 200 кириллических символов допустимы.
    let mut max_title = input("g3", &home);
    max_title.title = Some("я".repeat(200));
    assert!(repo::create_group(&mut conn, &max_title).is_ok());

    let mut too_wide = input("g4", &home);
    too_wide.frame.width = 8000.1;
    assert!(is_constraint(repo::create_group(&mut conn, &too_wide)));
    let mut widest = input("g5", &home);
    widest.frame.width = 8000.0;
    assert!(repo::create_group(&mut conn, &widest).is_ok());

    let ids: Vec<String> = conn
        .prepare("SELECT card_id FROM group_cards ORDER BY card_id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(ids, ["g3", "g5"]);
}

#[test]
fn create_requires_a_live_board() {
    let (mut conn, home) = workspace();
    assert!(matches!(
        repo::create_group(&mut conn, &input("g1", "nope")),
        Err(WorkspaceError::NotFound(id)) if id == "nope"
    ));

    child_board(&mut conn, &home, "child");
    trash_service::trash_board(&mut conn, "child").unwrap();
    assert!(matches!(
        repo::create_group(&mut conn, &input("g2", "child")),
        Err(WorkspaceError::NotFound(id)) if id == "child"
    ));
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM group_cards", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0, "nothing was written");
}

#[test]
fn update_changes_title_and_color_under_the_revision_check() {
    let (mut conn, home) = workspace();
    repo::create_group(&mut conn, &input("g", &home)).unwrap();

    let mut rename = update("g", 1);
    rename.title = Some("Sources".into());
    let receipt = repo::update_group(&mut conn, &rename).unwrap();
    assert_eq!((receipt.id.as_str(), receipt.revision), ("g", 2));

    let mut recolor = update("g", 2);
    recolor.color_token = Some("yellow".into());
    assert_eq!(repo::update_group(&mut conn, &recolor).unwrap().revision, 3);

    let stored = group(repo::load_card(&conn, "g").unwrap());
    assert_eq!(
        (stored.title.as_str(), stored.color_token.as_str()),
        ("Sources", "yellow"),
        "each update leaves the other field alone"
    );
    assert_eq!(stored.revision, 3);

    // Пустое имя — допустимое значение, а не «нет изменений».
    let mut clear = update("g", 3);
    clear.title = Some(String::new());
    repo::update_group(&mut conn, &clear).unwrap();
    assert_eq!(group(repo::load_card(&conn, "g").unwrap()).title, "");

    let mut stale = update("g", 1);
    stale.title = Some("Late".into());
    assert!(matches!(
        repo::update_group(&mut conn, &stale),
        Err(WorkspaceError::StaleRevision {
            expected: 1,
            actual: 4
        })
    ));
}

#[test]
fn update_validates_its_input() {
    let (mut conn, home) = workspace();
    repo::create_group(&mut conn, &input("g", &home)).unwrap();
    let is_constraint = |r| matches!(r, Err(WorkspaceError::ConstraintViolation(_)));

    assert!(is_constraint(repo::update_group(
        &mut conn,
        &update("g", 1)
    )));
    let mut bad_token = update("g", 1);
    bad_token.color_token = Some("red".into());
    assert!(is_constraint(repo::update_group(&mut conn, &bad_token)));
    let mut long_title = update("g", 1);
    long_title.title = Some("x".repeat(201));
    assert!(is_constraint(repo::update_group(&mut conn, &long_title)));
    assert_eq!(revision(&conn, "g"), 1, "nothing was written");

    let mut missing = update("nope", 1);
    missing.title = Some("x".into());
    assert!(matches!(
        repo::update_group(&mut conn, &missing),
        Err(WorkspaceError::NotFound(_))
    ));
    // Заметка — не группа.
    let mut note = update("a", 1);
    note.title = Some("x".into());
    assert!(matches!(
        repo::update_group(&mut conn, &note),
        Err(WorkspaceError::NotFound(_))
    ));

    trash_service::trash_note(&mut conn, "g").unwrap();
    let mut trashed = update("g", 1);
    trashed.title = Some("x".into());
    assert!(matches!(
        repo::update_group(&mut conn, &trashed),
        Err(WorkspaceError::NotFound(_))
    ));
}

#[test]
fn the_snapshot_shows_the_group_with_kind_group() {
    let (mut conn, home) = workspace();
    let mut named = input("g", &home);
    named.title = Some("Sources".into());
    named.color_token = Some("green".into());
    repo::create_group(&mut conn, &named).unwrap();

    let snapshot = repo::load_board_snapshot(&conn, &home).unwrap();
    let json = serde_json::to_value(&snapshot).unwrap();
    let wire = json["cards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "g")
        .expect("the group is on the canvas")
        .clone();
    assert_eq!(
        wire,
        serde_json::json!({
            "kind": "group",
            "id": "g",
            "boardId": home,
            "frame": { "x": 0.0, "y": 0.0, "width": 2400.0, "height": 900.0 },
            "zIndex": 0,
            "revision": 1,
            "title": "Sources",
            "colorToken": "green",
        })
    );
    // Группа не ищется в v1.
    let hits = repo::search_workspace(&conn, "Sources").unwrap();
    assert!(hits.iter().all(|h| h.entity_id != "g"), "{hits:?}");
}

#[test]
fn inputs_deserialize_from_the_wire_names() {
    let create: CreateGroupInput = serde_json::from_value(serde_json::json!({
        "id": "g",
        "boardId": "b",
        "frame": { "x": 1.0, "y": 2.0, "width": 300.0, "height": 200.0 },
        "zIndex": 0,
    }))
    .unwrap();
    assert_eq!((create.title, create.color_token), (None, None));

    let update: UpdateGroupInput = serde_json::from_value(serde_json::json!({
        "cardId": "g",
        "expectedRevision": 3,
        "colorToken": "pink",
    }))
    .unwrap();
    assert_eq!(update.card_id, "g");
    assert_eq!(update.expected_revision, 3);
    assert_eq!(update.title, None);
    assert_eq!(update.color_token.as_deref(), Some("pink"));
}

#[test]
fn mutations_are_journaled_with_stable_op_names() {
    let create = Mutation::CreateGroup(input("g", "home"));
    let update = Mutation::UpdateGroup(update("g", 1));
    assert_eq!(create.op_name(), "group.create");
    assert_eq!(update.op_name(), "group.update");
    assert!(!create.is_local_only() && !update.is_local_only());
}

#[test]
fn trash_and_restore_of_a_group_leave_the_members_untouched() {
    let (mut conn, home) = workspace();
    repo::create_group(&mut conn, &input("g", &home)).unwrap();
    let before = frames(&conn, &home);
    let revisions: Vec<i64> = ["a", "b", "c"]
        .iter()
        .map(|id| revision(&conn, id))
        .collect();

    // «Разгруппировать» — корзина одной группы.
    let batch = trash_service::trash_selection(
        &mut conn,
        &TrashSelectionInput {
            items: vec![TrashItem {
                id: "g".into(),
                kind: "group".into(),
            }],
        },
    )
    .unwrap();
    let snapshot = repo::load_board_snapshot(&conn, &home).unwrap();
    assert!(!card_ids(&snapshot.cards).contains(&"g"));
    assert_eq!(frames(&conn, &home), before, "members keep their frames");

    trash_service::restore_trash_batch(&mut conn, &batch).unwrap();
    let snapshot = repo::load_board_snapshot(&conn, &home).unwrap();
    assert!(card_ids(&snapshot.cards).contains(&"g"));
    assert_eq!(frames(&conn, &home), before);
    let after: Vec<i64> = ["a", "b", "c"]
        .iter()
        .map(|id| revision(&conn, id))
        .collect();
    assert_eq!(after, revisions, "members were never written");
}

#[test]
fn the_trash_list_shows_the_group_title() {
    let (mut conn, home) = workspace();
    let mut named = input("g1", &home);
    named.title = Some("Sources".into());
    repo::create_group(&mut conn, &named).unwrap();
    repo::create_group(&mut conn, &input("g2", &home)).unwrap();
    trash_service::trash_note(&mut conn, "g1").unwrap();
    trash_service::trash_note(&mut conn, "g2").unwrap();

    let summary = trash_service::list_trash(&conn).unwrap();
    let entries: Vec<(String, String, String)> = summary
        .batches
        .iter()
        .flat_map(|b| b.items.iter())
        .map(|e| (e.id.clone(), e.kind.clone(), e.title.clone()))
        .collect();
    assert!(entries.contains(&("g1".into(), "group".into(), "Sources".into())));
    assert!(
        entries.contains(&("g2".into(), "group".into(), String::new())),
        "an untitled group is listed with ''"
    );
}

#[test]
fn a_group_moves_to_another_board_and_through_unsorted_like_a_leaf() {
    let (mut conn, home) = workspace();
    child_board(&mut conn, &home, "child");
    repo::create_group(&mut conn, &input("g", &home)).unwrap();

    // На холст другой доски, в указанный кадр.
    let moved_to = Frame {
        x: 100.0,
        ..group_frame()
    };
    let rev = revision(&conn, "g");
    repo::move_card_to_board(
        &mut conn,
        &MoveCardToBoardInput {
            id: "g".into(),
            expected_revision: rev,
            target_board_id: "child".into(),
            frame: Some(moved_to),
        },
    )
    .unwrap();
    let child = repo::load_board_snapshot(&conn, "child").unwrap();
    let moved = group(child.cards.into_iter().next().expect("on the child canvas"));
    assert_eq!((moved.id.as_str(), moved.frame), ("g", moved_to));
    let home_ids = repo::load_board_snapshot(&conn, &home).unwrap();
    assert!(!card_ids(&home_ids.cards).contains(&"g"));

    // В Unsorted Home и обратно на холст.
    let rev = revision(&conn, "g");
    repo::move_cards_to_board_unsorted(
        &mut conn,
        &MoveCardsToUnsortedInput {
            target_board_id: home.clone(),
            cards: vec![MoveCardToUnsortedItem {
                id: "g".into(),
                expected_revision: rev,
            }],
        },
    )
    .unwrap();
    let home_snapshot = repo::load_board_snapshot(&conn, &home).unwrap();
    assert_eq!(card_ids(&home_snapshot.unsorted_cards), ["g"]);
    assert!(!card_ids(&home_snapshot.cards).contains(&"g"));
    assert!(repo::load_board_snapshot(&conn, "child")
        .unwrap()
        .cards
        .is_empty());

    let rev = revision(&conn, "g");
    repo::place_unsorted_card(
        &mut conn,
        &PlaceUnsortedCardInput {
            id: "g".into(),
            expected_revision: rev,
            frame: group_frame(),
        },
    )
    .unwrap();
    let home_snapshot = repo::load_board_snapshot(&conn, &home).unwrap();
    assert!(home_snapshot.unsorted_cards.is_empty());
    assert!(card_ids(&home_snapshot.cards).contains(&"g"));
}

#[test]
fn duplicate_board_copies_the_group() {
    let (mut conn, home) = workspace();
    child_board(&mut conn, &home, "src");
    let mut named = input("g", "src");
    named.title = Some("Sources".into());
    named.color_token = Some("gray".into());
    repo::create_group(&mut conn, &named).unwrap();

    duplicate_board::duplicate_board(
        &mut conn,
        &DuplicateBoardInput {
            source_board_id: "src".into(),
            target_board_id: home.clone(),
            new_board_id: "copy".into(),
            new_portal_card_id: "portal-copy".into(),
            frame: Frame {
                x: 6000.0,
                y: 0.0,
                width: 240.0,
                height: 160.0,
            },
        },
    )
    .unwrap();

    let copies: Vec<GroupCardDto> = repo::load_board_snapshot(&conn, "copy")
        .unwrap()
        .cards
        .into_iter()
        .map(group)
        .collect();
    assert_eq!(copies.len(), 1);
    let copy = &copies[0];
    assert_ne!(copy.id, "g");
    assert_eq!(copy.board_id, "copy");
    assert_eq!(copy.frame, group_frame());
    assert_eq!(
        (copy.title.as_str(), copy.color_token.as_str()),
        ("Sources", "gray")
    );
    assert_eq!(
        card_ids(&repo::load_board_snapshot(&conn, "src").unwrap().cards),
        ["g"],
        "the source is untouched"
    );
}

#[test]
fn a_connector_can_attach_to_a_group() {
    let (mut conn, home) = workspace();
    repo::create_group(&mut conn, &input("g", &home)).unwrap();
    let connector = repo::create_connector(
        &mut conn,
        &CreateConnectorInput {
            id: "k".into(),
            board_id: home.clone(),
            from_card_id: "g".into(),
            to_card_id: "c".into(),
            color_token: None,
            arrow_ends: None,
        },
    )
    .unwrap();
    assert_eq!(
        (
            connector.from_card_id.as_str(),
            connector.to_card_id.as_str()
        ),
        ("g", "c")
    );
    let shown: Vec<String> = repo::load_board_snapshot(&conn, &home)
        .unwrap()
        .connectors
        .into_iter()
        .map(|k| k.id)
        .collect();
    assert_eq!(shown, ["k"]);
}

#[test]
fn group_writes_bump_the_boards_change_seq() {
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
    repo::create_group(&mut conn, &input("g", &home)).unwrap();
    let created = seq(&conn);
    assert!(created > before);

    let mut recolor = update("g", 1);
    recolor.color_token = Some("pink".into());
    repo::update_group(&mut conn, &recolor).unwrap();
    assert!(seq(&conn) > created);
}
