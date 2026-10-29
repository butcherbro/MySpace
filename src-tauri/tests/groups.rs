//! Группы на холсте (ADR-0013): create/update группы, валидация и то, что
//! группа идёт общими путями карточки-листа (корзина, перенос, Unsorted,
//! дублирование доски, коннекторы, change_seq).

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::errors::WorkspaceError;
use myspace_lib::domain::models::{
    CardDto, CreateChildBoardInput, CreateConnectorInput, CreateGroupInput, CreateNoteInput,
    DuplicateBoardInput, Frame, GroupAssignment, GroupCardDto, GroupCreatedReceipt, MoveCardItem,
    MoveCardToBoardInput, MoveCardToUnsortedItem, MoveCardsInput, MoveCardsToUnsortedInput,
    PlaceUnsortedCardInput, TrashItem, TrashSelectionInput, UpdateGroupInput,
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
        member_ids: Vec::new(),
        group_id: None,
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
    let created = group(
        repo::create_group(&mut conn, &input("g", &home))
            .unwrap()
            .group,
    );
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
    let again = group(repo::create_group(&mut conn, &retry).unwrap().group);
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
    let created = group(repo::create_group(&mut conn, &named).unwrap().group);
    assert_eq!(created.title, "  Исследование  ");
    assert_eq!(created.color_token, "blue");
}

#[test]
fn create_validates_token_title_and_frame() {
    let (mut conn, home) = workspace();
    let is_constraint = |r: Result<GroupCreatedReceipt, WorkspaceError>| {
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
    assert!(wire["createdAt"].as_i64().unwrap() > 0, "{wire}");
    assert_eq!(
        wire,
        serde_json::json!({
            "kind": "group",
            "id": "g",
            "boardId": home,
            "frame": { "x": 0.0, "y": 0.0, "width": 2400.0, "height": 900.0 },
            "zIndex": 0,
            "revision": 1,
            "groupId": null,
            "createdAt": wire["createdAt"],
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

// ---- Хранимое членство (ADR-0013, ревизия 2026-10-28) ----------------------

fn with_members(id: &str, board: &str, members: &[&str]) -> CreateGroupInput {
    CreateGroupInput {
        member_ids: members.iter().map(|m| m.to_string()).collect(),
        ..input(id, board)
    }
}

/// `group_id`, как его отдаёт загрузчик (нормализованный).
fn loaded_group(conn: &Connection, card: &str) -> Option<String> {
    let json = serde_json::to_value(repo::load_card(conn, card).unwrap()).unwrap();
    json["groupId"].as_str().map(String::from)
}

/// `group_id`, как он хранится в колонке.
fn stored_group(conn: &Connection, card: &str) -> Option<String> {
    conn.query_row("SELECT group_id FROM cards WHERE id = ?1", [card], |r| {
        r.get(0)
    })
    .unwrap()
}

fn group_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM group_cards", [], |r| r.get(0))
        .unwrap()
}

fn move_item(conn: &Connection, card: &str, group: Option<Option<&str>>) -> MoveCardItem {
    let frame: Frame = conn
        .query_row(
            "SELECT x, y, width, height FROM cards WHERE id = ?1",
            [card],
            |r| {
                Ok(Frame {
                    x: r.get(0)?,
                    y: r.get(1)?,
                    width: r.get(2)?,
                    height: r.get(3)?,
                })
            },
        )
        .unwrap();
    MoveCardItem {
        id: card.into(),
        expected_revision: revision(conn, card),
        frame: Frame {
            x: frame.x + 10.0,
            ..frame
        },
        group: group.map(|g| GroupAssignment {
            group_id: g.map(String::from),
        }),
    }
}

/// Сдвиг карточек на 10 по x; `group`: `None` — без поля, `Some(g)` — с ним.
type MoveSpec<'a> = (&'a str, Option<Option<&'a str>>);

fn move_cards(
    conn: &mut Connection,
    specs: &[MoveSpec<'_>],
) -> Result<Vec<(String, i64)>, WorkspaceError> {
    let items = specs
        .iter()
        .map(|(card, group)| move_item(conn, card, *group))
        .collect();
    repo::move_cards(conn, &MoveCardsInput { cards: items })
        .map(|r| r.cards.into_iter().map(|c| (c.id, c.revision)).collect())
}

#[test]
fn create_with_members_sets_their_group_and_bumps_each_once() {
    let (mut conn, home) = workspace();
    let receipt =
        repo::create_group(&mut conn, &with_members("g", &home, &["a", "b", "a"])).unwrap();
    assert_eq!(group(receipt.group).id, "g");
    let members: Vec<(String, i64)> = receipt
        .members
        .into_iter()
        .map(|m| (m.id, m.revision))
        .collect();
    assert_eq!(
        members,
        [("a".to_string(), 2), ("b".to_string(), 2)],
        "a duplicate id is listed once"
    );
    assert_eq!(revision(&conn, "a"), 2, "one bump despite the duplicate");
    assert_eq!(loaded_group(&conn, "a").as_deref(), Some("g"));
    assert_eq!(loaded_group(&conn, "b").as_deref(), Some("g"));
    assert_eq!(loaded_group(&conn, "c"), None);
    assert_eq!(loaded_group(&conn, "g"), None);
    assert_eq!(revision(&conn, "c"), 1);
}

#[test]
fn create_rejects_bad_members_and_creates_nothing() {
    let (mut conn, home) = workspace();
    child_board(&mut conn, &home, "child");
    note(&mut conn, "child", "elsewhere", 0.0);
    note(&mut conn, &home, "trashed", 800.0);
    trash_service::trash_note(&mut conn, "trashed").unwrap();

    for members in [
        &["a", "nope"][..],
        &["a", "elsewhere"],
        &["a", "trashed"],
        &["a", "g"],
    ] {
        let result = repo::create_group(&mut conn, &with_members("g", &home, members));
        assert!(
            matches!(result, Err(WorkspaceError::ConstraintViolation(_))),
            "{members:?}: {result:?}"
        );
        assert_eq!(group_count(&conn), 0, "{members:?}: no group");
        assert_eq!(revision(&conn, "a"), 1, "{members:?}: a untouched");
        assert_eq!(stored_group(&conn, "a"), None);
    }
}

#[test]
fn an_idempotent_create_returns_the_group_with_no_members() {
    let (mut conn, home) = workspace();
    repo::create_group(&mut conn, &with_members("g", &home, &["a"])).unwrap();
    let again = repo::create_group(&mut conn, &with_members("g", &home, &["b"])).unwrap();
    assert_eq!(group(again.group).id, "g");
    assert!(again.members.is_empty());
    assert_eq!(loaded_group(&conn, "a").as_deref(), Some("g"));
    assert_eq!(loaded_group(&conn, "b"), None, "a repeat adds nobody");
    assert_eq!(revision(&conn, "b"), 1);
}

#[test]
fn move_cards_sets_keeps_and_clears_the_group_with_one_bump() {
    let (mut conn, home) = workspace();
    repo::create_group(&mut conn, &input("g", &home)).unwrap();

    let joined = move_cards(&mut conn, &[("a", Some(Some("g")))]).unwrap();
    assert_eq!(joined, [("a".to_string(), 2)], "frame + group = one bump");
    assert_eq!(loaded_group(&conn, "a").as_deref(), Some("g"));

    // Без `group` членство не меняется.
    move_cards(&mut conn, &[("a", None)]).unwrap();
    assert_eq!(loaded_group(&conn, "a").as_deref(), Some("g"));

    let left = move_cards(&mut conn, &[("a", Some(None))]).unwrap();
    assert_eq!(left, [("a".to_string(), 4)]);
    assert_eq!(stored_group(&conn, "a"), None);
}

#[test]
fn move_cards_rejects_bad_targets_and_rolls_back_the_batch() {
    let (mut conn, home) = workspace();
    repo::create_group(&mut conn, &input("g", &home)).unwrap();
    child_board(&mut conn, &home, "child");
    repo::create_group(&mut conn, &input("far", "child")).unwrap();
    repo::create_group(&mut conn, &input("gone", &home)).unwrap();
    trash_service::trash_note(&mut conn, "gone").unwrap();

    for target in ["nope", "b", "far", "gone"] {
        let result = move_cards(
            &mut conn,
            &[("c", Some(Some("g"))), ("a", Some(Some(target)))],
        );
        assert!(
            matches!(result, Err(WorkspaceError::ConstraintViolation(_))),
            "{target}: {result:?}"
        );
        assert_eq!(revision(&conn, "c"), 1, "{target}: the batch rolled back");
        assert_eq!(stored_group(&conn, "c"), None);
    }
    let own = move_cards(&mut conn, &[("g", Some(Some("g")))]);
    assert!(matches!(own, Err(WorkspaceError::ConstraintViolation(_))));
}

#[test]
fn move_cards_refuses_a_membership_cycle() {
    let (mut conn, home) = workspace();
    repo::create_group(&mut conn, &input("outer", &home)).unwrap();
    repo::create_group(&mut conn, &with_members("inner", &home, &["a"])).unwrap();
    move_cards(&mut conn, &[("inner", Some(Some("outer")))]).unwrap();

    // outer ⊃ inner ⊃ a: ни outer в inner, ни outer в a (не группа) нельзя.
    let cycle = move_cards(&mut conn, &[("outer", Some(Some("inner")))]);
    assert!(matches!(cycle, Err(WorkspaceError::ConstraintViolation(_))));
    assert_eq!(stored_group(&conn, "outer"), None);

    // Битые хранимые данные (цикл inner ↔ outer) не зацикливают проверку.
    conn.execute("UPDATE cards SET group_id = 'inner' WHERE id = 'outer'", [])
        .unwrap();
    let ok = move_cards(&mut conn, &[("b", Some(Some("inner")))]);
    assert!(ok.is_ok(), "{ok:?}");
}

#[test]
fn membership_is_dormant_while_the_group_is_away() {
    let (mut conn, home) = workspace();
    child_board(&mut conn, &home, "child");
    repo::create_group(&mut conn, &with_members("g", &home, &["a"])).unwrap();

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
    assert_eq!(
        loaded_group(&conn, "a"),
        None,
        "a trashed group is no group"
    );
    assert_eq!(stored_group(&conn, "a").as_deref(), Some("g"));
    trash_service::restore_trash_batch(&mut conn, &batch).unwrap();
    assert_eq!(loaded_group(&conn, "a").as_deref(), Some("g"));

    // Группа на другой доске — тоже «сон».
    let rev = revision(&conn, "g");
    repo::move_card_to_board(
        &mut conn,
        &MoveCardToBoardInput {
            id: "g".into(),
            expected_revision: rev,
            target_board_id: "child".into(),
            frame: Some(group_frame()),
        },
    )
    .unwrap();
    assert_eq!(loaded_group(&conn, "a"), None);
    let snapshot = repo::load_board_snapshot(&conn, &home).unwrap();
    let json = serde_json::to_value(&snapshot).unwrap();
    let a = json["cards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "a")
        .unwrap();
    assert_eq!(
        a["groupId"],
        serde_json::Value::Null,
        "the board load agrees"
    );
}

#[test]
fn duplicate_board_remaps_membership_to_the_copied_group() {
    let (mut conn, home) = workspace();
    child_board(&mut conn, &home, "src");
    note(&mut conn, "src", "m", 10.0);
    note(&mut conn, "src", "orphan", 500.0);
    repo::create_group(&mut conn, &with_members("g", "src", &["m"])).unwrap();
    repo::create_group(&mut conn, &with_members("gone", "src", &["orphan"])).unwrap();
    trash_service::trash_note(&mut conn, "gone").unwrap();

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

    let json = serde_json::to_value(repo::load_board_snapshot(&conn, "copy").unwrap()).unwrap();
    let cards = json["cards"].as_array().unwrap();
    let copy_group = cards.iter().find(|c| c["kind"] == "group").unwrap();
    let notes: Vec<&serde_json::Value> = cards.iter().filter(|c| c["kind"] == "note").collect();
    assert_eq!(notes.len(), 2);
    let members: Vec<&serde_json::Value> = notes.iter().map(|n| &n["groupId"]).collect();
    assert!(members.contains(&&copy_group["id"]), "{members:?}");
    assert!(
        members.contains(&&serde_json::Value::Null),
        "the trashed group was not copied"
    );
    let stored_nulls: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE board_id = 'copy' AND kind = 'note' AND group_id IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stored_nulls, 1, "no dangling id is copied");
}

#[test]
fn membership_inputs_deserialize_from_the_wire_names() {
    let create: CreateGroupInput = serde_json::from_value(serde_json::json!({
        "id": "g", "boardId": "b", "zIndex": 0,
        "frame": { "x": 1.0, "y": 2.0, "width": 300.0, "height": 200.0 },
        "memberIds": ["a", "b"],
    }))
    .unwrap();
    assert_eq!(create.member_ids, ["a", "b"]);
    assert_eq!(create.group_id, None);
    let nested: CreateGroupInput = serde_json::from_value(serde_json::json!({
        "id": "g", "boardId": "b", "zIndex": 0,
        "frame": { "x": 1.0, "y": 2.0, "width": 300.0, "height": 200.0 },
        "groupId": "outer",
    }))
    .unwrap();
    assert_eq!(nested.group_id.as_deref(), Some("outer"));

    let item = |extra: serde_json::Value| -> MoveCardItem {
        let mut json = serde_json::json!({
            "id": "a", "expectedRevision": 1,
            "frame": { "x": 1.0, "y": 2.0, "width": 300.0, "height": 200.0 },
        });
        json.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(json).unwrap()
    };
    assert_eq!(item(serde_json::json!({})).group, None);
    assert_eq!(
        item(serde_json::json!({ "group": { "groupId": null } })).group,
        Some(GroupAssignment { group_id: None })
    );
    assert_eq!(
        item(serde_json::json!({ "group": { "groupId": "g" } })).group,
        Some(GroupAssignment {
            group_id: Some("g".into())
        })
    );

    let receipt = GroupCreatedReceipt {
        group: CardDto::Group(GroupCardDto {
            id: "g".into(),
            board_id: "b".into(),
            frame: group_frame(),
            z_index: 0,
            revision: 1,
            group_id: None,
            created_at: 0,
            title: String::new(),
            color_token: "default".into(),
        }),
        members: Vec::new(),
    };
    let wire = serde_json::to_value(&receipt).unwrap();
    assert_eq!(wire["group"]["kind"], "group");
    assert_eq!(wire["members"], serde_json::json!([]));
}

#[test]
fn create_can_nest_the_new_group_in_another_group() {
    let (mut conn, home) = workspace();
    repo::create_group(&mut conn, &input("outer", &home)).unwrap();
    let nested = CreateGroupInput {
        group_id: Some("outer".into()),
        ..with_members("inner", &home, &["a", "b"])
    };
    let receipt = repo::create_group(&mut conn, &nested).unwrap();
    assert_eq!(group(receipt.group).group_id.as_deref(), Some("outer"));
    assert_eq!(loaded_group(&conn, "inner").as_deref(), Some("outer"));
    assert_eq!(loaded_group(&conn, "a").as_deref(), Some("inner"));

    // Повтор игнорирует `group_id`.
    let repeat = CreateGroupInput {
        group_id: None,
        ..with_members("inner", &home, &[])
    };
    repo::create_group(&mut conn, &repeat).unwrap();
    assert_eq!(stored_group(&conn, "inner").as_deref(), Some("outer"));
}

#[test]
fn create_rejects_a_bad_parent_group_and_creates_nothing() {
    let (mut conn, home) = workspace();
    child_board(&mut conn, &home, "child");
    repo::create_group(&mut conn, &input("far", "child")).unwrap();
    repo::create_group(&mut conn, &input("gone", &home)).unwrap();
    trash_service::trash_note(&mut conn, "gone").unwrap();

    for parent in ["nope", "b", "far", "gone", "g"] {
        let result = repo::create_group(
            &mut conn,
            &CreateGroupInput {
                group_id: Some(parent.into()),
                ..with_members("g", &home, &["a"])
            },
        );
        assert!(
            matches!(result, Err(WorkspaceError::ConstraintViolation(_))),
            "{parent}: {result:?}"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM cards WHERE id = 'g'", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0,
            "{parent}: nothing created"
        );
        assert_eq!(revision(&conn, "a"), 1, "{parent}: member untouched");
    }
}

#[test]
fn placing_a_card_from_unsorted_drops_its_dormant_group() {
    let (mut conn, home) = workspace();
    repo::create_group(&mut conn, &with_members("g", &home, &["a"])).unwrap();

    let rev = revision(&conn, "a");
    repo::move_cards_to_board_unsorted(
        &mut conn,
        &MoveCardsToUnsortedInput {
            target_board_id: home.clone(),
            cards: vec![MoveCardToUnsortedItem {
                id: "a".into(),
                expected_revision: rev,
            }],
        },
    )
    .unwrap();
    assert_eq!(stored_group(&conn, "a").as_deref(), Some("g"), "dormant");
    // Группа жива на холсте, но карточка в Unsorted — членства нет.
    assert_eq!(loaded_group(&conn, "a"), None);
    let unsorted = serde_json::to_value(repo::load_board_snapshot(&conn, &home).unwrap()).unwrap()
        ["unsortedCards"]
        .clone();
    let listed = unsorted
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "a")
        .expect("a is in Unsorted");
    assert_eq!(listed["groupId"], serde_json::Value::Null);

    let rev = revision(&conn, "a");
    repo::place_unsorted_card(
        &mut conn,
        &PlaceUnsortedCardInput {
            id: "a".into(),
            expected_revision: rev,
            frame: Frame {
                x: 50.0,
                y: 100.0,
                width: 200.0,
                height: 80.0,
            },
        },
    )
    .unwrap();
    assert_eq!(loaded_group(&conn, "a"), None);
    assert_eq!(stored_group(&conn, "a"), None);
}
