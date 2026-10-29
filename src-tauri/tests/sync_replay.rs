//! ADR-0011 S1 + S2: the change journal and the replay engine, end to end on
//! real workspaces in temp dirs (distinct data dirs → distinct device ids).
//! The "transport" here is a function call: export rows from one workspace
//! with the other's cursors, apply them through the other's writer funnel.

use std::collections::BTreeMap;
use std::path::PathBuf;

use myspace_lib::app::{Workspace, WorkspacePaths};
use myspace_lib::domain::models::{
    AssetDto, CardDto, CreateBoardShortcutInput, CreateConnectorInput, CreateFilesystemAliasInput,
    CreateGroupInput, CreateImageCardInput, CreateLinkBatchInput, CreateNoteInput, Frame,
    GroupAssignment, LinkBatchItem, MoveCardItem, MoveCardsInput, UpdateCardFrameInput,
    UpdateConnectorInput, UpdateNoteInput,
};
use myspace_lib::domain::mutation::Mutation;
use myspace_lib::domain::plain_text::plain_text_to_document;
use myspace_lib::repositories::{devices, workspace_repository as repo};
use myspace_lib::services::workspace_service::WorkspaceService;
use myspace_lib::sync::{journal, ApplyReport, ChangeRow, ROOT_BOARD_ALIAS};
use serde_json::Value;

const SHA: &str = "5a2d1f0c9b8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6b5a4938271605f4e";

struct Replica {
    ws: Workspace,
    dir: PathBuf,
}

impl Replica {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("myspace-sync-{tag}-{}", uuid::Uuid::now_v7()));
        let ws = Workspace::open(WorkspacePaths::new(&dir)).unwrap();
        Self { ws, dir }
    }

    fn device(&self) -> String {
        self.ws
            .read_blocking(|c| Ok(devices::load_device_identity(c)?.device_id))
            .unwrap()
    }

    fn home(&self) -> String {
        self.ws
            .read_blocking(|c| {
                Ok(c.query_row("SELECT root_board_id FROM workspaces", [], |r| r.get(0))?)
            })
            .unwrap()
    }

    fn apply(&self, m: Mutation) -> myspace_lib::domain::mutation::MutationOutcome {
        self.ws.apply_blocking(m).unwrap()
    }

    fn apply_rows(&self, rows: Vec<ChangeRow>) -> ApplyReport {
        self.apply(Mutation::ApplySyncChanges(rows))
            .into_sync_report()
            .unwrap()
    }

    fn revision(&self, card: &str) -> i64 {
        let card = card.to_string();
        self.ws
            .read_blocking(move |c| {
                Ok(
                    c.query_row("SELECT revision FROM cards WHERE id = ?1", [&card], |r| {
                        r.get(0)
                    })?,
                )
            })
            .unwrap()
    }

    fn scalar<T: rusqlite::types::FromSql + Send + 'static>(
        &self,
        sql: &str,
        arg: &str,
    ) -> Option<T> {
        let (sql, arg) = (sql.to_string(), arg.to_string());
        self.ws
            .read_blocking(move |c| {
                use rusqlite::OptionalExtension;
                Ok(c.query_row(&sql, [&arg], |r| r.get(0)).optional()?)
            })
            .unwrap()
    }

    /// `SELECT COUNT(*)` with no parameters.
    fn count(&self, sql: &str) -> i64 {
        let sql = sql.to_string();
        self.ws
            .read_blocking(move |c| Ok(c.query_row(&sql, [], |r| r.get(0))?))
            .unwrap()
    }

    fn note_text(&self, card: &str) -> Option<String> {
        self.scalar("SELECT plain_text FROM note_cards WHERE card_id = ?1", card)
    }

    fn cursors(&self) -> BTreeMap<String, String> {
        self.ws.read_blocking(journal::our_cursors).unwrap()
    }

    /// Everything this replica holds that `peer` lacks, fetched in small
    /// pages so the continuation is exercised.
    fn export_for(&self, peer: &Replica) -> Vec<ChangeRow> {
        let mut cursors = peer.cursors();
        let mut rows = Vec::new();
        loop {
            let c = cursors.clone();
            let page = self
                .ws
                .read_blocking(move |conn| journal::changes_since(conn, &c, 7))
                .unwrap();
            rows.extend(page.rows);
            match page.next {
                Some(next) => cursors = next,
                None => return rows,
            }
        }
    }

    /// Normalized board snapshot: device-local fields removed (revision,
    /// viewport, shortcut `local` / origin device name), Home's id aliased.
    fn board(&self, board_id: &str) -> Value {
        let id = board_id.to_string();
        let snapshot = self
            .ws
            .read_blocking(move |c| repo::load_board_snapshot(c, &id))
            .unwrap();
        let text = serde_json::to_string(&snapshot)
            .unwrap()
            .replace(&self.home(), ROOT_BOARD_ALIAS);
        let mut value: Value = serde_json::from_str(&text).unwrap();
        strip(&mut value);
        value
    }
}

impl Drop for Replica {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn strip(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for key in [
                "revision",
                "updatedAt",
                "viewport",
                "local",
                "originDeviceName",
            ] {
                map.remove(key);
            }
            map.values_mut().for_each(strip);
        }
        Value::Array(items) => items.iter_mut().for_each(strip),
        _ => {}
    }
}

/// One-way exchange `from` → `to`.
fn sync(from: &Replica, to: &Replica) -> ApplyReport {
    to.apply_rows(from.export_for(to))
}

/// Both ways, twice (the second round carries what the first created, e.g.
/// conflict copies).
fn converge(a: &Replica, b: &Replica) {
    for _ in 0..2 {
        sync(a, b);
        sync(b, a);
    }
}

fn frame(x: f64) -> Frame {
    Frame {
        x,
        y: 40.0,
        width: 240.0,
        height: 160.0,
    }
}

fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

fn create_note(r: &Replica, board: &str, text: &str) -> String {
    let id = new_id();
    r.apply(Mutation::CreateNote(CreateNoteInput {
        id: id.clone(),
        board_id: board.to_string(),
        frame: frame(10.0),
        z_index: 1,
        document_json: plain_text_to_document(text),
    }));
    id
}

fn update_note(r: &Replica, card: &str, text: &str) {
    r.apply(Mutation::UpdateNote(UpdateNoteInput {
        id: card.to_string(),
        expected_revision: r.revision(card),
        document_json: plain_text_to_document(text),
        acknowledge_corrupt: false,
    }));
}

struct Fixture {
    board: String,
    child: String,
    note: String,
    image: String,
    alias: String,
    /// Коннектор note → image.
    connector: String,
}

/// Scenario (a)'s content, created on `a` only.
fn populate(a: &Replica) -> Fixture {
    let home = a.home();
    let board = WorkspaceService::create_board(&a.ws, &home, "Project").unwrap();
    let note = create_note(a, &board, "hello from A");
    let asset_id = new_id();
    a.apply(Mutation::InsertAsset(AssetDto {
        id: asset_id.clone(),
        file_name: "photo.png".into(),
        mime_type: "image/png".into(),
        width: Some(10),
        height: Some(12),
        size_bytes: 3,
        file_path: format!("{asset_id}.png"),
        sha256: Some(SHA.into()),
    }));
    let image = new_id();
    a.apply(Mutation::CreateImageCard(CreateImageCardInput {
        id: image.clone(),
        board_id: board.clone(),
        frame: frame(300.0),
        z_index: 2,
        asset_id,
        caption_json: plain_text_to_document("a caption"),
    }));
    WorkspaceService::create_link_batch(
        &a.ws,
        &CreateLinkBatchInput {
            idempotency_key: new_id(),
            board_id: board.clone(),
            links: vec![LinkBatchItem {
                id: new_id(),
                source_url: "https://example.com/a".into(),
                title: "Example".into(),
                description: "a link".into(),
            }],
        },
    )
    .unwrap();
    let child = WorkspaceService::create_board(&a.ws, &board, "Child").unwrap();
    let alias = new_id();
    a.apply(Mutation::CreateFilesystemAlias(
        CreateFilesystemAliasInput {
            id: alias.clone(),
            board_id: board.clone(),
            frame: frame(600.0),
            z_index: 3,
            target_kind: "folder".into(),
            locator_blob: b"path:v1:/tmp/research".to_vec(),
            path_hint: "/tmp/research".into(),
            display_name: "Research".into(),
        },
    ));
    a.apply(Mutation::CreateBoardShortcut(CreateBoardShortcutInput {
        id: new_id(),
        board_id: home.clone(),
        frame: frame(900.0),
        z_index: 4,
        target_board_id: child.clone(),
    }));
    // Группа шире старого предела 1600: проверяет и новый MAX_WIDTH на реплике.
    a.apply(Mutation::CreateGroup(CreateGroupInput {
        id: new_id(),
        board_id: board.clone(),
        frame: Frame {
            x: 0.0,
            y: 400.0,
            width: 2400.0,
            height: 900.0,
        },
        z_index: 0,
        title: Some("Sources".into()),
        color_token: Some("green".into()),
        member_ids: Vec::new(),
        group_id: None,
    }));
    let connector = new_id();
    a.apply(Mutation::CreateConnector(CreateConnectorInput {
        id: connector.clone(),
        board_id: board.clone(),
        from_card_id: note.clone(),
        to_card_id: image.clone(),
        color_token: Some("blue".into()),
        arrow_ends: None,
    }));
    Fixture {
        board,
        child,
        note,
        image,
        alias,
        connector,
    }
}

/// Id коннекторов, которые показывает снимок доски `board` на реплике.
fn shown_connectors(r: &Replica, board: &str) -> Vec<String> {
    let id = board.to_string();
    r.ws.read_blocking(move |c| repo::load_board_snapshot(c, &id))
        .unwrap()
        .connectors
        .into_iter()
        .map(|c| c.id)
        .collect()
}

fn connector_revision(r: &Replica, id: &str) -> i64 {
    r.scalar("SELECT revision FROM connectors WHERE id = ?1", id)
        .unwrap()
}

fn alias_dto(r: &Replica, id: &str) -> myspace_lib::domain::models::FilesystemAliasDto {
    let id = id.to_string();
    match r
        .ws
        .read_blocking(move |c| repo::load_card(c, &id))
        .unwrap()
    {
        CardDto::FilesystemAlias(alias) => alias,
        other => panic!("not an alias: {other:?}"),
    }
}

#[test]
fn a_board_with_every_kind_replicates_and_shortcuts_are_foreign() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    assert_ne!(
        a.device(),
        b.device(),
        "distinct data dirs, distinct devices"
    );
    let fx = populate(&a);

    let report = sync(&a, &b);
    assert_eq!(report.pending, 0, "{report:?}");
    assert_eq!(report.rejected, 0, "{report:?}");
    assert!(report.touched_boards.contains(&b.home()), "{report:?}");

    assert_eq!(b.board(&fx.board), a.board(&fx.board));
    assert_eq!(b.board(&fx.child), a.board(&fx.child));
    assert_eq!(
        b.board(&b.home()),
        a.board(&a.home()),
        "portal + shortcut on Home"
    );
    let groups: Vec<Value> = b.board(&fx.board)["cards"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["kind"] == "group")
        .cloned()
        .collect();
    assert_eq!(groups.len(), 1, "the group replicated");
    assert_eq!(
        (&groups[0]["title"], &groups[0]["colorToken"]),
        (&Value::from("Sources"), &Value::from("green"))
    );

    // The folder shortcut is board content everywhere but opens only on A.
    assert!(alias_dto(&a, &fx.alias).local);
    let foreign = alias_dto(&b, &fx.alias);
    assert!(!foreign.local);
    assert_eq!(foreign.origin_device_id, a.device());
    let locators: i64 = b
        .scalar(
            "SELECT COUNT(*) FROM filesystem_alias_locators WHERE card_id = ?1",
            &fx.alias,
        )
        .unwrap();
    assert_eq!(locators, 0, "no locator bytes ever travel");

    // The image's blob is not here yet: listed, and the card still loads.
    let status =
        b.ws.read_blocking({
            let dir = b.ws.paths().assets_dir();
            move |c| journal::status(c, &dir)
        })
        .unwrap();
    assert_eq!(status.missing_blobs, vec![SHA.to_string()]);
    assert_eq!(status.pending_count, 0);
    assert_eq!(
        status.cursors.get(&a.device()),
        a.cursors().get(&a.device())
    );
    let image = fx.image.clone();
    assert!(matches!(
        b.ws.read_blocking(move |c| repo::load_card(c, &image))
            .unwrap(),
        CardDto::Image(_)
    ));

    // Replayed rows are stored with their origin, not re-journaled by B.
    let own_rows: i64 = b
        .scalar(
            "SELECT COUNT(*) FROM changes WHERE origin_device_id = ?1 AND op <> 'snapshot'",
            &b.device(),
        )
        .unwrap();
    assert_eq!(own_rows, 0);
}

#[test]
fn concurrent_note_edits_converge_with_a_conflict_copy_on_both() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let fx = populate(&a);
    sync(&a, &b);

    // A later edit on top of a synced one is sequential: no conflict copy.
    update_note(&b, &fx.note, "B's first edit");
    sync(&b, &a);
    assert_eq!(a.note_text(&fx.note).as_deref(), Some("B's first edit"));

    // Offline on both.
    update_note(&a, &fx.note, "A's offline text");
    update_note(&b, &fx.note, "B's offline text");
    converge(&a, &b);

    let text_a = a.note_text(&fx.note).unwrap();
    assert_eq!(Some(text_a.clone()), b.note_text(&fx.note));
    assert!(text_a == "A's offline text" || text_a == "B's offline text");

    let copies = |r: &Replica| -> Vec<String> {
        let board = fx.board.clone();
        r.ws.read_blocking(move |c| {
            let mut stmt = c.prepare(
                "SELECT n.plain_text FROM note_cards n JOIN cards c ON c.id = n.card_id
                 WHERE c.board_id = ?1 AND n.plain_text LIKE 'Conflict copy%' ORDER BY c.id",
            )?;
            let rows = stmt.query_map([&board], |r| r.get(0))?;
            Ok(rows.collect::<Result<Vec<String>, _>>()?)
        })
        .unwrap()
    };
    let on_a = copies(&a);
    assert_eq!(on_a.len(), 1, "{on_a:?}");
    assert_eq!(on_a, copies(&b));
    let loser = if text_a == "A's offline text" {
        "B's offline text"
    } else {
        "A's offline text"
    };
    assert!(on_a[0].contains(loser), "{on_a:?}");
    assert_eq!(a.board(&fx.board), b.board(&fx.board));
}

#[test]
fn trash_beats_a_concurrent_move() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let fx = populate(&a);
    sync(&a, &b);

    a.apply(Mutation::TrashNote {
        card_id: fx.note.clone(),
    });
    b.apply(Mutation::MoveCard(UpdateCardFrameInput {
        id: fx.note.clone(),
        expected_revision: b.revision(&fx.note),
        frame: frame(777.0),
    }));
    converge(&a, &b);

    for r in [&a, &b] {
        let deleted: Option<i64> = r.scalar("SELECT deleted_at FROM cards WHERE id = ?1", &fx.note);
        assert!(deleted.is_some(), "trashed on both");
        let x: f64 = r
            .scalar("SELECT x FROM cards WHERE id = ?1", &fx.note)
            .unwrap();
        assert_eq!(x, 777.0, "the move is kept too");
    }
    assert_eq!(a.board(&fx.board), b.board(&fx.board));

    // A restore is a newer op and wins everywhere.
    let batch: String = a
        .scalar("SELECT trash_batch_id FROM cards WHERE id = ?1", &fx.note)
        .unwrap();
    b.apply(Mutation::RestoreTrashBatch { batch_id: batch });
    converge(&a, &b);
    for r in [&a, &b] {
        let deleted: Option<Option<i64>> =
            r.scalar("SELECT deleted_at FROM cards WHERE id = ?1", &fx.note);
        assert_eq!(deleted, Some(None), "restored on both");
    }
}

#[test]
fn empty_trash_purges_everywhere_and_late_edits_never_resurrect() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let fx = populate(&a);
    sync(&a, &b);

    // B edits while A trashes and empties: B's edit is "late".
    update_note(&b, &fx.note, "B edits a doomed note");
    a.apply(Mutation::TrashNote {
        card_id: fx.note.clone(),
    });
    // The child board too: its subtree and the shortcut pointing at it go.
    a.apply(Mutation::TrashBoard {
        board_id: fx.child.clone(),
    });
    a.apply(Mutation::EmptyTrash {
        confirmation: "EMPTY".into(),
    });
    assert!(a.note_text(&fx.note).is_none());
    let purges: i64 = a
        .scalar("SELECT COUNT(*) FROM changes WHERE op = ?1", "purge")
        .unwrap();
    assert!(purges >= 3, "note, portal, board (+ shortcut): {purges}");

    let report = sync(&a, &b);
    assert!(report.applied > 0);
    assert!(b.note_text(&fx.note).is_none(), "B applied the purge");
    let report = sync(&b, &a);
    assert!(report.dropped_purged >= 1, "{report:?}");
    converge(&a, &b);

    for r in [&a, &b] {
        assert!(r.note_text(&fx.note).is_none());
        let purged: i64 = r
            .scalar("SELECT COUNT(*) FROM purged WHERE entity_id = ?1", &fx.note)
            .unwrap();
        assert_eq!(purged, 1);
        let child: Option<String> = r.scalar("SELECT id FROM boards WHERE id = ?1", &fx.child);
        assert!(child.is_none());
    }
    assert_eq!(a.board(&fx.board), b.board(&fx.board));
    assert_eq!(a.board(&a.home()), b.board(&b.home()));
}

#[test]
fn out_of_order_delivery_parks_and_converges() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let home = a.home();
    let board = WorkspaceService::create_board(&a.ws, &home, "Late board").unwrap();
    let note = create_note(&a, &board, "first");
    update_note(&a, &note, "second");

    let rows = a.export_for(&b);
    let (card_rows, other_rows): (Vec<ChangeRow>, Vec<ChangeRow>) = rows
        .into_iter()
        .partition(|r| r.entity_kind == "card" && r.entity_id == note);
    assert_eq!(card_rows.len(), 2, "create + update");

    // The note's update and create arrive first (reversed), without its board.
    let mut early = card_rows.clone();
    early.reverse();
    let report = b.apply_rows(early);
    assert_eq!(report.parked, 2, "{report:?}");
    assert_eq!(report.pending, 2);
    assert!(b.note_text(&note).is_none());

    let report = b.apply_rows(other_rows);
    assert_eq!(report.pending, 0, "{report:?}");
    assert_eq!(b.note_text(&note).as_deref(), Some("second"));
    assert_eq!(b.board(&board), a.board(&board));
}

#[test]
fn reapplying_a_batch_is_a_no_op() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let fx = populate(&a);
    let rows = a.export_for(&b);
    b.apply_rows(rows.clone());
    let before = (b.board(&fx.board), b.revision(&fx.note), b.cursors());
    let changes_before: i64 = b.count("SELECT COUNT(*) FROM changes");

    let report = b.apply_rows(rows.clone());
    assert_eq!(report.duplicates, rows.len());
    assert_eq!(report.applied, 0);
    assert!(report.touched_boards.is_empty());
    assert_eq!(
        (b.board(&fx.board), b.revision(&fx.note), b.cursors()),
        before
    );
    let changes_after: i64 = b.count("SELECT COUNT(*) FROM changes");
    assert_eq!(changes_after, changes_before);
}

#[test]
fn a_third_device_learns_a_through_b() {
    let (a, b, c) = (Replica::new("a"), Replica::new("b"), Replica::new("c"));
    let fx = populate(&a);
    sync(&a, &b);
    update_note(&b, &fx.note, "edited on B");

    let report = sync(&b, &c);
    assert_eq!(report.pending, 0, "{report:?}");
    assert_eq!(c.note_text(&fx.note).as_deref(), Some("edited on B"));
    assert!(
        c.cursors().contains_key(&a.device()),
        "A's rows were forwarded"
    );
    sync(&b, &a);
    assert_eq!(c.board(&fx.board), a.board(&fx.board));
    assert_eq!(c.board(&fx.child), a.board(&fx.child));
    // C's shortcut is foreign too, attributed to A.
    assert_eq!(alias_dto(&c, &fx.alias).origin_device_id, a.device());

    // Nothing to exchange once converged.
    assert!(b.export_for(&c).is_empty());
}

#[test]
fn writes_through_the_mcp_path_are_journaled() {
    let a = Replica::new("a");
    let home = a.home();
    // A second process's handle on the same database, as the MCP server
    // opens it: its own writer connection, same funnel.
    let mcp = Workspace::open_existing(WorkspacePaths::new(&a.dir)).unwrap();
    let before = a.cursors().get(&a.device()).cloned().unwrap_or_default();

    let board = WorkspaceService::create_board(&mcp, &home, "From an agent").unwrap();
    let batch = WorkspaceService::create_link_batch(
        &mcp,
        &CreateLinkBatchInput {
            idempotency_key: new_id(),
            board_id: board.clone(),
            links: vec![LinkBatchItem {
                id: new_id(),
                source_url: "https://example.com/mcp".into(),
                title: "Agent link".into(),
                description: String::new(),
            }],
        },
    )
    .unwrap();
    // Interleave a write from the app's own writer.
    create_note(&a, &board, "from the app");

    let rows: Vec<(String, String, String, String)> = a
        .ws
        .read_blocking(|c| {
            let mut stmt = c.prepare(
                "SELECT origin_device_id, hlc, op, entity_id FROM changes WHERE op <> 'snapshot' ORDER BY seq",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .unwrap();
    assert!(rows.iter().all(|r| r.0 == a.device()));
    assert!(rows
        .iter()
        .any(|r| r.2 == "board.create_child" && r.3 == board));
    assert!(rows
        .iter()
        .any(|r| r.2 == "link_batch.create" && r.3 == batch.card_ids[0]));
    let hlcs: Vec<&String> = rows.iter().map(|r| &r.1).collect();
    let mut sorted = hlcs.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted, hlcs, "strictly increasing across both processes");
    assert!(*hlcs[0] > before);
}

#[test]
fn pre_journal_data_is_backfilled_once_and_syncs() {
    let dir = std::env::temp_dir().join(format!("myspace-sync-legacy-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("workspace.sqlite3");
    let (board, note) = (new_id(), new_id());
    {
        // Written without the funnel, as data from before migration 0025.
        let mut conn = myspace_lib::db::open(&db).unwrap();
        myspace_lib::db::bootstrap::bootstrap(&mut conn).unwrap();
        let home: String = conn
            .query_row("SELECT root_board_id FROM workspaces", [], |r| r.get(0))
            .unwrap();
        myspace_lib::domain::board_service::create_child_board(
            &mut conn,
            &myspace_lib::domain::models::CreateChildBoardInput {
                parent_board_id: home,
                board_id: board.clone(),
                portal_card_id: new_id(),
                frame: frame(0.0),
                title: "Legacy".into(),
            },
        )
        .unwrap();
        repo::create_note(
            &mut conn,
            &CreateNoteInput {
                id: note.clone(),
                board_id: board.clone(),
                frame: frame(0.0),
                z_index: 0,
                document_json: plain_text_to_document("old text"),
            },
        )
        .unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM changes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }
    let legacy = Replica {
        ws: Workspace::open(WorkspacePaths::new(&dir)).unwrap(),
        dir: dir.clone(),
    };
    let ops: Vec<(String, String)> = legacy
        .ws
        .read_blocking(|c| {
            let mut stmt = c.prepare("SELECT op, entity_kind FROM changes ORDER BY hlc")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .unwrap();
    assert!(ops.iter().all(|(op, _)| op == "snapshot"));
    let kinds: Vec<&str> = ops.iter().map(|(_, k)| k.as_str()).collect();
    assert_eq!(
        kinds,
        ["board", "board", "card", "card"],
        "Home, Legacy, portal, note"
    );

    // Reopening does not snapshot again.
    let mut legacy = legacy;
    legacy.ws = Workspace::open(WorkspacePaths::new(&dir)).unwrap();
    let count: i64 = legacy
        .scalar("SELECT COUNT(*) FROM changes WHERE op = ?1", "snapshot")
        .unwrap();
    assert_eq!(count, 4);

    let fresh = Replica::new("fresh");
    sync(&legacy, &fresh);
    assert_eq!(fresh.note_text(&note).as_deref(), Some("old text"));
    assert_eq!(fresh.board(&board), legacy.board(&board));
}

#[test]
fn an_asset_collected_between_batches_is_restored_from_the_journal() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let fx = populate(&a);
    let rows = a.export_for(&b);
    let (assets, rest): (Vec<ChangeRow>, Vec<ChangeRow>) =
        rows.into_iter().partition(|r| r.entity_kind == "asset");
    assert_eq!(b.apply_rows(assets).pending, 0);
    // Per-replica GC: the asset is unreferenced here until its card arrives.
    let collected = b
        .apply(Mutation::CollectOrphanedAssets)
        .into_count()
        .unwrap();
    assert_eq!(collected, 1);

    let report = b.apply_rows(rest);
    assert_eq!(report.pending, 0, "{report:?}");
    assert_eq!(b.board(&fx.board), a.board(&fx.board));
    let image = fx.image.clone();
    assert!(matches!(
        b.ws.read_blocking(move |c| repo::load_card(c, &image))
            .unwrap(),
        CardDto::Image(_)
    ));
}

#[test]
fn a_failed_mutation_leaves_no_journal_row() {
    let a = Replica::new("a");
    let home = a.home();
    let note = create_note(&a, &home, "v1");
    let count = |r: &Replica| -> i64 { r.count("SELECT COUNT(*) FROM changes") };
    let before = count(&a);
    let stale = a.ws.apply_blocking(Mutation::UpdateNote(UpdateNoteInput {
        id: note.clone(),
        expected_revision: a.revision(&note) + 5,
        document_json: plain_text_to_document("never stored"),
        acknowledge_corrupt: false,
    }));
    assert!(stale.is_err());
    assert_eq!(count(&a), before);
    assert_eq!(a.note_text(&note).as_deref(), Some("v1"));

    // A local-only write (the viewport) is never journaled either.
    let revision: i64 = a
        .scalar(
            "SELECT revision FROM board_view_states WHERE board_id = ?1",
            &home,
        )
        .unwrap();
    a.apply(Mutation::SaveViewport(
        myspace_lib::domain::models::UpdateViewportInput {
            board_id: home,
            expected_revision: revision,
            x: 5.0,
            y: 5.0,
            zoom: 2.0,
        },
    ));
    assert_eq!(count(&a), before);
}

#[test]
fn a_connector_replicates_and_follows_trash_and_restore() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let fx = populate(&a);
    let report = sync(&a, &b);
    assert_eq!(report.pending, 0, "{report:?}");
    assert_eq!(report.rejected, 0, "{report:?}");
    assert_eq!(
        shown_connectors(&b, &fx.board),
        std::slice::from_ref(&fx.connector)
    );
    assert_eq!(b.board(&fx.board), a.board(&fx.board));

    // Правка на B едет обратно.
    b.apply(Mutation::UpdateConnector(UpdateConnectorInput {
        connector_id: fx.connector.clone(),
        expected_revision: connector_revision(&b, &fx.connector),
        color_token: Some("pink".into()),
        arrow_ends: Some("both".into()),
        from_card_id: None,
        to_card_id: None,
        label: None,
    }));
    let report = sync(&b, &a);
    assert!(report.touched_boards.contains(&fx.board), "{report:?}");
    let color: String = a
        .scalar(
            "SELECT color_token FROM connectors WHERE id = ?1",
            &fx.connector,
        )
        .unwrap();
    assert_eq!(color, "pink");

    // Корзина конца на A прячет коннектор на B, с тем же батчем.
    let batch = a
        .apply(Mutation::TrashNote {
            card_id: fx.note.clone(),
        })
        .into_id()
        .unwrap();
    sync(&a, &b);
    assert!(shown_connectors(&b, &fx.board).is_empty());
    let on_b: Option<String> = b.scalar(
        "SELECT trash_batch_id FROM connectors WHERE id = ?1",
        &fx.connector,
    );
    assert_eq!(on_b, Some(batch.clone()));

    a.apply(Mutation::RestoreTrashBatch { batch_id: batch });
    sync(&a, &b);
    assert_eq!(
        shown_connectors(&b, &fx.board),
        std::slice::from_ref(&fx.connector)
    );
    assert_eq!(b.board(&fx.board), a.board(&fx.board));

    // Удаление пользователем мягкое и едет регистром `life`.
    a.apply(Mutation::RemoveConnector {
        connector_id: fx.connector.clone(),
    });
    sync(&a, &b);
    assert!(connector_deleted(&b, &fx.connector));
    assert!(shown_connectors(&b, &fx.board).is_empty());
    assert_eq!(b.board(&fx.board), a.board(&fx.board));
}

fn connector_deleted(r: &Replica, id: &str) -> bool {
    let deleted: Option<Option<i64>> =
        r.scalar("SELECT deleted_at FROM connectors WHERE id = ?1", id);
    matches!(deleted, Some(Some(_)))
}

fn recolor(r: &Replica, id: &str, color: &str) {
    r.apply(Mutation::UpdateConnector(UpdateConnectorInput {
        connector_id: id.to_string(),
        expected_revision: connector_revision(r, id),
        color_token: Some(color.into()),
        arrow_ends: None,
        from_card_id: None,
        to_card_id: None,
        label: None,
    }));
}

/// Удаление на A и более новая (по HLC) перекраска на B: перекраска остаётся,
/// но коннектор удалён на обоих — правка не отменяет удаление.
#[test]
fn a_newer_recolour_never_undoes_a_concurrent_remove() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let fx = populate(&a);
    sync(&a, &b);

    a.apply(Mutation::RemoveConnector {
        connector_id: fx.connector.clone(),
    });
    std::thread::sleep(std::time::Duration::from_millis(5));
    recolor(&b, &fx.connector, "pink");
    converge(&a, &b);

    for r in [&a, &b] {
        assert!(connector_deleted(r, &fx.connector));
        assert!(shown_connectors(r, &fx.board).is_empty());
        let color: String = r
            .scalar(
                "SELECT color_token FROM connectors WHERE id = ?1",
                &fx.connector,
            )
            .unwrap();
        assert_eq!(color, "pink", "the edit itself is kept");
    }
    assert_eq!(a.board(&fx.board), b.board(&fx.board));
}

/// Обратный порядок: перекраска на B раньше удаления на A.
#[test]
fn a_remove_newer_than_a_concurrent_recolour_wins() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let fx = populate(&a);
    sync(&a, &b);

    recolor(&b, &fx.connector, "pink");
    std::thread::sleep(std::time::Duration::from_millis(5));
    a.apply(Mutation::RemoveConnector {
        connector_id: fx.connector.clone(),
    });
    converge(&a, &b);

    for r in [&a, &b] {
        assert!(connector_deleted(r, &fx.connector));
        assert!(shown_connectors(r, &fx.board).is_empty());
    }
    assert_eq!(a.board(&fx.board), b.board(&fx.board));
}

#[test]
fn a_late_connector_edit_never_resurrects_a_purged_cards_connector() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let fx = populate(&a);
    sync(&a, &b);

    // A кладёт конец в корзину и очищает её; B, ещё не знающий об этом,
    // правит коннектор позже: строка B новее удаления на A.
    a.apply(Mutation::TrashNote {
        card_id: fx.note.clone(),
    });
    a.apply(Mutation::EmptyTrash {
        confirmation: "EMPTY".into(),
    });
    std::thread::sleep(std::time::Duration::from_millis(5));
    b.apply(Mutation::UpdateConnector(UpdateConnectorInput {
        connector_id: fx.connector.clone(),
        expected_revision: connector_revision(&b, &fx.connector),
        color_token: Some("green".into()),
        arrow_ends: None,
        from_card_id: None,
        to_card_id: None,
        label: None,
    }));

    let report = sync(&b, &a);
    assert_eq!(report.pending, 0, "{report:?}");
    assert!(report.dropped_purged >= 1, "{report:?}");
    converge(&a, &b);

    for r in [&a, &b] {
        let rows: i64 = r
            .scalar(
                "SELECT COUNT(*) FROM connectors WHERE id = ?1",
                &fx.connector,
            )
            .unwrap();
        assert_eq!(rows, 0);
        let pending: i64 = r.count("SELECT COUNT(*) FROM pending_changes");
        assert_eq!(pending, 0, "nothing parked forever");
    }
    assert_eq!(a.board(&fx.board), b.board(&fx.board));
}

/// HLC устройства `peerx`, `offset_ms` от текущего времени.
fn peer_hlc(offset_ms: i64, counter: u32) -> String {
    let wall = myspace_lib::db::migrations::now_millis() + offset_ms;
    format!("{wall:015}-{counter:05}-peerx")
}

/// Строка журнала коннектора от `peerx`.
fn peer_connector_row(id: &str, hlc: &str, clocks: Value, state: Value) -> ChangeRow {
    ChangeRow {
        origin_device_id: "peerx".into(),
        hlc: hlc.into(),
        entity_kind: "connector".into(),
        entity_id: id.into(),
        op: "connector.update".into(),
        payload_json: serde_json::json!({ "v": 1, "clocks": clocks, "state": state }).to_string(),
    }
}

fn live_connector_state(fx: &Fixture, color: &str) -> Value {
    serde_json::json!({
        "present": true,
        "board_id": fx.board,
        "from_card_id": fx.note,
        "to_card_id": fx.image,
        "color_token": color,
        "arrow_ends": "end",
        "label": null,
        "created_at": 1,
        "deleted_at": null,
        "trash_batch_id": null,
    })
}

/// `present: false` с более новыми часами `body`, пришедшая раньше самой
/// перекраски, не делает перекраску устаревшей: такая строка двигает только
/// часы `life`, а `life` здесь новее (локальный restore).
#[test]
fn an_absent_row_never_supersedes_the_recolour_it_carries() {
    let a = Replica::new("a");
    let fx = populate(&a);
    let batch = a
        .apply(Mutation::TrashNote {
            card_id: fx.note.clone(),
        })
        .into_id()
        .unwrap();
    a.apply(Mutation::RestoreTrashBatch { batch_id: batch });

    let body = peer_hlc(60_000, 0);
    let old_life = "000000000000001-00000-peerx";
    let absent = peer_connector_row(
        &fx.connector,
        &peer_hlc(60_000, 1),
        serde_json::json!({ "body": body, "life": old_life }),
        serde_json::json!({ "present": false }),
    );
    let report = a.apply_rows(vec![absent]);
    assert_eq!(report.superseded, 1, "{report:?}");
    assert_eq!(
        shown_connectors(&a, &fx.board),
        std::slice::from_ref(&fx.connector)
    );

    let recolour = peer_connector_row(
        &fx.connector,
        &body,
        serde_json::json!({ "body": body, "life": old_life }),
        live_connector_state(&fx, "pink"),
    );
    let report = a.apply_rows(vec![recolour]);
    assert_eq!(report.applied, 1, "{report:?}");
    let color: String = a
        .scalar(
            "SELECT color_token FROM connectors WHERE id = ?1",
            &fx.connector,
        )
        .unwrap();
    assert_eq!(color, "pink");
    assert!(!connector_deleted(&a, &fx.connector));
}

/// Строки, поставленные в очередь миграцией 0027, применяются при старте
/// (`retry_pending_blocking`), не дожидаясь непустой страницы от пира.
#[test]
fn queued_connector_rows_apply_at_startup_without_a_peer_page() {
    let a = Replica::new("a");
    let fx = populate(&a);
    let id = new_id();
    let hlc = peer_hlc(0, 0);
    let row = peer_connector_row(
        &id,
        &hlc,
        serde_json::json!({ "body": hlc, "life": hlc }),
        live_connector_state(&fx, "green"),
    );

    // Как у старой сборки: строка лежит в `changes`, но не применена.
    let mut raw = rusqlite::Connection::open(a.ws.paths().db_path()).unwrap();
    raw.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    raw.execute(
        "INSERT INTO changes (origin_device_id, hlc, entity_kind, entity_id, op, payload_json, received_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
        rusqlite::params![
            row.origin_device_id,
            row.hlc,
            row.entity_kind,
            row.entity_id,
            row.op,
            row.payload_json
        ],
    )
    .unwrap();
    let tx = raw.transaction().unwrap();
    myspace_lib::db::migrations::requeue_connector_changes(&tx).unwrap();
    tx.commit().unwrap();
    drop(raw);
    assert!(shown_connectors(&a, &fx.board).iter().all(|k| *k != id));

    let report = myspace_lib::sync::retry_pending_blocking(&a.ws)
        .unwrap()
        .expect("there were parked rows");
    assert_eq!(report.pending, 0, "{report:?}");
    assert!(shown_connectors(&a, &fx.board).contains(&id));
    assert!(
        myspace_lib::sync::retry_pending_blocking(&a.ws)
            .unwrap()
            .is_none(),
        "nothing left to retry"
    );
}

/// Старая сборка сохранила в `changes` и отвергла строки группы, включая
/// тумбстоун её стирания (у него нет `state.kind`). После шага миграции 0028
/// в очереди все строки группы, и повтор при старте не воскрешает её.
#[test]
fn a_purged_group_rejected_by_an_old_build_stays_purged_after_the_upgrade() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let group = new_id();
    a.apply(Mutation::CreateGroup(CreateGroupInput {
        id: group.clone(),
        board_id: a.home(),
        frame: frame(0.0),
        z_index: 0,
        title: Some("Doomed".into()),
        color_token: None,
        member_ids: Vec::new(),
        group_id: None,
    }));
    a.apply(Mutation::TrashNote {
        card_id: group.clone(),
    });
    a.apply(Mutation::EmptyTrash {
        confirmation: "EMPTY".into(),
    });
    let rows: Vec<ChangeRow> = a
        .export_for(&b)
        .into_iter()
        .filter(|r| r.entity_id == group)
        .collect();
    assert!(rows.iter().any(|r| r.op == "group.create"), "{rows:?}");
    assert!(rows.iter().any(|r| r.op == "purge"), "{rows:?}");

    // Как старая сборка: строки лежат в `changes` (курсор сдвинут), но не применены.
    let mut conn = rusqlite::Connection::open(b.ws.paths().db_path()).unwrap();
    for r in &rows {
        conn.execute(
            "INSERT INTO changes (origin_device_id, hlc, entity_kind, entity_id, op, payload_json, received_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
            rusqlite::params![r.origin_device_id, r.hlc, r.entity_kind, r.entity_id, r.op, r.payload_json],
        )
        .unwrap();
    }
    let tx = conn.transaction().unwrap();
    myspace_lib::db::migrations::requeue_group_card_changes(&tx).unwrap();
    tx.commit().unwrap();
    let queued: Vec<String> = conn
        .prepare("SELECT op FROM pending_changes WHERE entity_id = ?1 ORDER BY hlc")
        .unwrap()
        .query_map([&group], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        queued.len(),
        rows.len(),
        "every row of the group: {queued:?}"
    );
    assert_eq!(queued.last().map(String::as_str), Some("purge"));
    drop(conn);

    let report = myspace_lib::sync::retry_pending_blocking(&b.ws)
        .unwrap()
        .expect("there were parked rows");
    assert_eq!(report.pending, 0, "{report:?}");
    let cards: i64 = b
        .scalar("SELECT COUNT(*) FROM cards WHERE id = ?1", &group)
        .unwrap();
    assert_eq!(cards, 0, "the purged group did not come back");
    let purged: i64 = b
        .scalar("SELECT COUNT(*) FROM purged WHERE entity_id = ?1", &group)
        .unwrap();
    assert_eq!(purged, 1);
}

// ---- Хранимое членство в группе (ADR-0013, ревизия 2026-10-28) -------------

fn create_group_with(r: &Replica, members: &[&str]) -> String {
    let id = new_id();
    r.apply(Mutation::CreateGroup(CreateGroupInput {
        id: id.clone(),
        board_id: r.home(),
        frame: Frame {
            x: 0.0,
            y: 0.0,
            width: 2400.0,
            height: 900.0,
        },
        z_index: 0,
        title: None,
        color_token: None,
        member_ids: members.iter().map(|m| m.to_string()).collect(),
        group_id: None,
    }));
    id
}

fn set_group(r: &Replica, card: &str, group: Option<&str>) {
    let x: f64 = r.scalar("SELECT x FROM cards WHERE id = ?1", card).unwrap();
    r.apply(Mutation::MoveCards(MoveCardsInput {
        cards: vec![MoveCardItem {
            id: card.to_string(),
            expected_revision: r.revision(card),
            frame: frame(x + 1.0),
            group: Some(GroupAssignment {
                group_id: group.map(String::from),
            }),
        }],
    }));
}

fn stored_group(r: &Replica, card: &str) -> Option<String> {
    r.scalar::<Option<String>>("SELECT group_id FROM cards WHERE id = ?1", card)
        .flatten()
}

fn loaded_group(r: &Replica, card: &str) -> Option<String> {
    let id = card.to_string();
    let dto =
        r.ws.read_blocking(move |c| repo::load_card(c, &id))
            .unwrap();
    serde_json::to_value(dto).unwrap()["groupId"]
        .as_str()
        .map(String::from)
}

#[test]
fn group_membership_replicates_with_the_card_image() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let home = a.home();
    let n1 = create_note(&a, &home, "one");
    let n2 = create_note(&a, &home, "two");
    let group = create_group_with(&a, &[&n1]);
    sync(&a, &b);
    assert_eq!(loaded_group(&b, &n1), Some(group.clone()));
    assert_eq!(loaded_group(&b, &n2), None);

    set_group(&a, &n1, None);
    set_group(&a, &n2, Some(&group));
    let rows = a.export_for(&b);
    let image: Value = serde_json::from_str(
        &rows
            .iter()
            .rev()
            .find(|r| r.entity_id == n2)
            .unwrap()
            .payload_json,
    )
    .unwrap();
    assert_eq!(image["state"]["group_id"], Value::String(group.clone()));
    b.apply_rows(rows);
    assert_eq!(stored_group(&b, &n1), None);
    assert_eq!(loaded_group(&b, &n2), Some(group));
    assert_eq!(a.board(&home), b.board(&b.home()));
}

/// Образ без ключа `group_id` пишет сборка старше ADR-0013: она не знает о
/// группах, и её перенос карточки не снимает членство.
#[test]
fn a_card_image_without_group_id_keeps_the_membership() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let home = a.home();
    let n1 = create_note(&a, &home, "one");
    create_group_with(&a, &[&n1]);
    let rows = a.export_for(&b);
    b.apply_rows(rows.clone());
    assert!(stored_group(&b, &n1).is_some());

    let latest = rows.iter().rev().find(|r| r.entity_id == n1).unwrap();
    let mut envelope: Value = serde_json::from_str(&latest.payload_json).unwrap();
    envelope["state"]
        .as_object_mut()
        .unwrap()
        .remove("group_id");
    envelope["state"]["x"] = serde_json::json!(500.0);
    let hlc = peer_hlc(60_000, 0);
    envelope["clocks"]["place"] = Value::String(hlc.clone());
    let report = b.apply_rows(vec![ChangeRow {
        origin_device_id: "peerx".into(),
        hlc,
        entity_kind: "card".into(),
        entity_id: n1.clone(),
        op: "card.move_many".into(),
        payload_json: envelope.to_string(),
    }]);
    assert_eq!(report.applied, 1, "{report:?}");
    assert!(stored_group(&b, &n1).is_some());
    assert_eq!(
        b.scalar::<f64>("SELECT x FROM cards WHERE id = ?1", &n1),
        Some(500.0),
        "the frame moved"
    );
}

/// Стирание группы не пишет в участников: колонка остаётся, загрузчик её
/// прячет.
#[test]
fn a_purged_group_leaves_its_members_rows_untouched() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let home = a.home();
    let n1 = create_note(&a, &home, "one");
    let group = create_group_with(&a, &[&n1]);
    sync(&a, &b);
    let revision = b.revision(&n1);

    a.apply(Mutation::TrashNote {
        card_id: group.clone(),
    });
    a.apply(Mutation::EmptyTrash {
        confirmation: "EMPTY".into(),
    });
    sync(&a, &b);
    assert_eq!(
        b.scalar::<String>("SELECT id FROM cards WHERE id = ?1", &group),
        None
    );
    assert_eq!(stored_group(&b, &n1), Some(group));
    assert_eq!(loaded_group(&b, &n1), None);
    assert_eq!(b.revision(&n1), revision, "the member was not written");
}

/// Членство едет в регистре `place`: перенос в группу на одном устройстве и
/// правка текста на другом не конфликтуют и оба сохраняются.
#[test]
fn joining_a_group_never_conflicts_with_a_concurrent_text_edit() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let home = a.home();
    let n1 = create_note(&a, &home, "one");
    let group = create_group_with(&a, &[]);
    sync(&a, &b);

    update_note(&a, &n1, "one, edited");
    set_group(&b, &n1, Some(&group));
    converge(&a, &b);

    for r in [&a, &b] {
        assert_eq!(r.note_text(&n1).as_deref(), Some("one, edited"));
        assert_eq!(loaded_group(r, &n1), Some(group.clone()));
        let notes: Option<i64> = r.scalar(
            "SELECT COUNT(*) FROM cards WHERE board_id = ?1 AND kind = 'note'",
            &r.home(),
        );
        assert_eq!(notes, Some(1), "no conflict copy");
    }
}

// ---- Строки для более новой сборки (откладываются, а не отвергаются) -------

/// Строка журнала от `peerx` с произвольным видом сущности и payload.
fn peer_row(kind: &str, id: &str, hlc: &str, payload: String) -> ChangeRow {
    ChangeRow {
        origin_device_id: "peerx".into(),
        hlc: hlc.into(),
        entity_kind: kind.into(),
        entity_id: id.into(),
        op: "test.write".into(),
        payload_json: payload,
    }
}

/// `(reason, attempts)` строки `hlc` в `pending_changes`.
fn pending_entry(r: &Replica, hlc: &str) -> Option<(Option<String>, i64)> {
    let hlc = hlc.to_string();
    r.ws.read_blocking(move |c| {
        use rusqlite::OptionalExtension;
        Ok(c.query_row(
            "SELECT reason, attempts FROM pending_changes WHERE hlc = ?1",
            [&hlc],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
    })
    .unwrap()
}

fn raw_connection(r: &Replica) -> rusqlite::Connection {
    let raw = rusqlite::Connection::open(r.ws.paths().db_path()).unwrap();
    raw.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    raw
}

/// Как после обновления приложения: сохранённые возможности сборки другие.
fn simulate_upgrade(r: &Replica) {
    raw_connection(r)
        .execute(
            "INSERT INTO local_meta (key, value) VALUES ('sync_capabilities', 'older-build')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )
        .unwrap();
}

/// The newest journal image of `id` this replica holds.
fn latest_image(r: &Replica, id: &str) -> Value {
    let text: String = r
        .scalar(
            "SELECT payload_json FROM changes WHERE entity_id = ?1 ORDER BY hlc DESC LIMIT 1",
            id,
        )
        .unwrap();
    serde_json::from_str(&text).unwrap()
}

/// Неизвестный вид сущности откладывается: курсор уже сдвинут, и пир строку
/// больше не пришлёт. В лимит попыток отложенная строка не идёт.
#[test]
fn a_row_of_an_unknown_entity_kind_is_deferred_not_rejected() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let hlc = peer_hlc(0, 0);
    let row = peer_row(
        "widget",
        &new_id(),
        &hlc,
        serde_json::json!({ "v": 1, "clocks": { "body": hlc }, "state": { "size": 3 } })
            .to_string(),
    );
    let report = a.apply_rows(vec![row]);
    assert_eq!((report.deferred, report.rejected), (1, 0), "{report:?}");
    assert_eq!(a.cursors().get("peerx"), Some(&hlc));
    assert_eq!(
        pending_entry(&a, &hlc),
        Some((Some("entity_kind".into()), 1))
    );

    create_note(&b, &b.home(), "unrelated");
    let report = sync(&b, &a);
    assert_eq!((report.deferred, report.rejected), (0, 0), "{report:?}");
    assert!(
        myspace_lib::sync::retry_pending_blocking(&a.ws)
            .unwrap()
            .is_none(),
        "only a deferred row and the same build: nothing to retry at startup"
    );
    assert_eq!(
        pending_entry(&a, &hlc),
        Some((Some("entity_kind".into()), 1)),
        "never retried, attempts never bumped"
    );

    // Обновление, которое этот вид так и не принесло: строка снова отложена.
    simulate_upgrade(&a);
    let report = myspace_lib::sync::retry_pending_blocking(&a.ws)
        .unwrap()
        .expect("the capabilities changed");
    assert_eq!((report.deferred, report.pending), (1, 1), "{report:?}");
    assert_eq!(
        pending_entry(&a, &hlc),
        Some((Some("entity_kind".into()), 1)),
        "re-deferred, attempts not bumped"
    );
}

/// Отложенная строка применяется, когда сборка узнала её вид: при старте
/// после обновления (сменились сохранённые возможности сборки).
#[test]
fn a_deferred_row_applies_once_the_build_knows_its_kind() {
    let a = Replica::new("a");
    let fx = populate(&a);
    let id = new_id();
    let hlc = peer_hlc(0, 0);
    let row = peer_connector_row(
        &id,
        &hlc,
        serde_json::json!({ "body": hlc, "life": hlc }),
        live_connector_state(&fx, "green"),
    );

    // Как отложила бы сборка, ещё не знавшая коннекторов.
    let raw = raw_connection(&a);
    for table in ["changes", "pending_changes"] {
        let (column, value) = if table == "changes" {
            ("received_at", "0")
        } else {
            ("received_at, attempts, reason", "0, 1, 'entity_kind'")
        };
        raw.execute(
            &format!(
                "INSERT INTO {table}
                    (origin_device_id, hlc, entity_kind, entity_id, op, payload_json, {column})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, {value})"
            ),
            rusqlite::params![
                row.origin_device_id,
                row.hlc,
                row.entity_kind,
                row.entity_id,
                row.op,
                row.payload_json
            ],
        )
        .unwrap();
    }
    drop(raw);
    simulate_upgrade(&a);
    assert!(!shown_connectors(&a, &fx.board).contains(&id));

    let report = myspace_lib::sync::retry_pending_blocking(&a.ws)
        .unwrap()
        .expect("there was a deferred row");
    assert_eq!((report.applied, report.pending), (1, 0), "{report:?}");
    assert!(shown_connectors(&a, &fx.board).contains(&id));
    assert_eq!(
        a.scalar::<String>(
            "SELECT value FROM local_meta WHERE key = ?1",
            "sync_capabilities"
        ),
        Some(myspace_lib::sync::capabilities())
    );
    assert!(
        myspace_lib::sync::retry_pending_blocking(&a.ws)
            .unwrap()
            .is_none(),
        "nothing left to retry"
    );
}

#[test]
fn an_invalid_payload_is_still_rejected() {
    let a = Replica::new("a");
    let hlc = peer_hlc(0, 0);
    let report = a.apply_rows(vec![peer_row("card", &new_id(), &hlc, "not json".into())]);
    assert_eq!((report.rejected, report.deferred), (1, 0), "{report:?}");
    assert_eq!(a.count("SELECT COUNT(*) FROM pending_changes"), 0);
}

/// Версию старше текущей не прочтёт ни одна сборка: строка отвергается.
#[test]
fn an_older_payload_version_is_rejected() {
    let a = Replica::new("a");
    let hlc = peer_hlc(0, 0);
    let payload = serde_json::json!({ "v": 0, "clocks": { "place": hlc }, "state": {} });
    let report = a.apply_rows(vec![peer_row("card", &new_id(), &hlc, payload.to_string())]);
    assert_eq!((report.rejected, report.deferred), (1, 0), "{report:?}");
    assert_eq!(a.count("SELECT COUNT(*) FROM pending_changes"), 0);
}

#[test]
fn a_newer_payload_version_is_deferred() {
    let a = Replica::new("a");
    let hlc = peer_hlc(0, 0);
    // `clocks` не того вида: образ не разбирается как `Envelope` v1, но `v`
    // читается.
    let payload = serde_json::json!({ "v": 2, "clocks": "x", "state": {} });
    let report = a.apply_rows(vec![peer_row("card", &new_id(), &hlc, payload.to_string())]);
    assert_eq!((report.deferred, report.rejected), (1, 0), "{report:?}");
    assert_eq!(
        pending_entry(&a, &hlc),
        Some((Some("payload_version".into()), 1))
    );
    assert_eq!(a.cursors().get("peerx"), Some(&hlc));
}

/// Карточка неизвестного вида откладывается; её стирание применяется сразу,
/// и после обновления отложенное создание отбрасывается как стёртое, а не
/// воскрешает карточку.
#[test]
fn a_card_of_an_unknown_kind_is_deferred_and_a_later_purge_still_wins() {
    let a = Replica::new("a");
    let template = create_note(&a, &a.home(), "template");
    let mut envelope = latest_image(&a, &template);
    envelope["state"]["kind"] = Value::String("widget".into());
    let id = new_id();
    let create = peer_hlc(0, 0);
    for reg in ["place", "life", "body"] {
        envelope["clocks"][reg] = Value::String(create.clone());
    }
    let report = a.apply_rows(vec![peer_row("card", &id, &create, envelope.to_string())]);
    assert_eq!(report.deferred, 1, "{report:?}");
    assert_eq!(
        pending_entry(&a, &create),
        Some((Some("card_kind".into()), 1))
    );

    let purge = peer_hlc(1_000, 0);
    let tombstone = serde_json::json!({ "v": 1, "purge": true }).to_string();
    let report = a.apply_rows(vec![peer_row("card", &id, &purge, tombstone)]);
    assert_eq!(report.applied, 1, "{report:?}");

    simulate_upgrade(&a);
    let report = myspace_lib::sync::retry_pending_blocking(&a.ws)
        .unwrap()
        .expect("there was a deferred row");
    assert_eq!(
        (report.dropped_purged, report.pending),
        (1, 0),
        "{report:?}"
    );
    assert_eq!(
        a.scalar::<String>("SELECT id FROM cards WHERE id = ?1", &id),
        None
    );
}

/// Неизвестный регистр не останавливает известные: перенос применяется, а
/// строка остаётся отложенной, чтобы новый регистр лёг после обновления.
#[test]
fn a_row_with_an_unknown_register_applies_the_known_ones_and_is_deferred() {
    let a = Replica::new("a");
    let n1 = create_note(&a, &a.home(), "one");
    let mut envelope = latest_image(&a, &n1);
    let hlc = peer_hlc(60_000, 0);
    envelope["state"]["x"] = serde_json::json!(500.0);
    envelope["clocks"]["place"] = Value::String(hlc.clone());
    envelope["clocks"]["tags"] = Value::String(hlc.clone());
    let row = peer_row("card", &n1, &hlc, envelope.to_string());

    let report = a.apply_rows(vec![row]);
    assert_eq!((report.applied, report.deferred), (1, 1), "{report:?}");
    assert_eq!(
        a.scalar::<f64>("SELECT x FROM cards WHERE id = ?1", &n1),
        Some(500.0)
    );
    assert_eq!(pending_entry(&a, &hlc), Some((Some("register".into()), 1)));

    simulate_upgrade(&a);
    let report = myspace_lib::sync::retry_pending_blocking(&a.ws)
        .unwrap()
        .expect("there was a deferred row");
    assert_eq!((report.superseded, report.deferred), (1, 1), "{report:?}");
    assert_eq!(
        pending_entry(&a, &hlc),
        Some((Some("register".into()), 1)),
        "re-deferred, attempts not bumped"
    );
}

/// Компакция не удаляет строку с членством ради более новой строки старой
/// сборки без ключа `group_id`: реплика из сжатого журнала тоже видит группу.
#[test]
fn compaction_keeps_the_membership_row_an_old_build_row_would_dominate() {
    let (a, c) = (Replica::new("a"), Replica::new("c"));
    let home = a.home();
    let n1 = create_note(&a, &home, "one");
    create_group_with(&a, &[&n1]);
    let (grouped_hlc, grouped): (String, String) = {
        let id = n1.clone();
        a.ws.read_blocking(move |c| {
            Ok(c.query_row(
                "SELECT hlc, payload_json FROM changes WHERE entity_id = ?1
                 ORDER BY hlc DESC LIMIT 1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap()
    };
    let mut envelope: Value = serde_json::from_str(&grouped).unwrap();
    assert!(envelope["state"]["group_id"].is_string());

    envelope["state"]
        .as_object_mut()
        .unwrap()
        .remove("group_id");
    envelope["state"]["x"] = serde_json::json!(500.0);
    let hlc = peer_hlc(60_000, 0);
    envelope["clocks"]["place"] = Value::String(hlc.clone());
    let report = a.apply_rows(vec![peer_row("card", &n1, &hlc, envelope.to_string())]);
    assert_eq!(report.applied, 1, "{report:?}");
    assert!(stored_group(&a, &n1).is_some());

    // Строка с членством перестаёт быть головой своего источника.
    let n2 = create_note(&a, &home, "two");
    for text in ["two, 1", "two, 2", "two, 3"] {
        update_note(&a, &n2, text);
    }
    myspace_lib::sync::compact::run_blocking(&a.ws).unwrap();

    let kept: bool = {
        let (device, hlc) = (a.device(), grouped_hlc.clone());
        a.ws.read_blocking(move |c| {
            Ok(c.query_row(
                "SELECT EXISTS (SELECT 1 FROM changes WHERE origin_device_id = ?1 AND hlc = ?2)",
                [&device, &hlc],
                |r| r.get(0),
            )?)
        })
        .unwrap()
    };
    assert!(kept, "the membership row survived compaction");
    sync(&a, &c);
    assert!(stored_group(&c, &n1).is_some());
}

/// Карточка, созданная из образа старой сборки (без ключа `group_id`),
/// создаётся без группы.
#[test]
fn a_card_created_from_an_image_without_group_id_has_no_group() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let n1 = create_note(&a, &a.home(), "one");
    create_group_with(&a, &[&n1]);
    let mut envelope = latest_image(&a, &n1);
    assert!(envelope["state"]["group_id"].is_string());
    envelope["state"]
        .as_object_mut()
        .unwrap()
        .remove("group_id");
    let hlc = peer_hlc(0, 0);
    for reg in ["place", "life", "body"] {
        envelope["clocks"][reg] = Value::String(hlc.clone());
    }
    let report = b.apply_rows(vec![peer_row("card", &n1, &hlc, envelope.to_string())]);
    assert_eq!(report.applied, 1, "{report:?}");
    assert_eq!(stored_group(&b, &n1), None);
}

/// Строка ассета от `peerx` с образом `state`.
fn peer_asset_row(id: &str, hlc: &str, state: Value) -> ChangeRow {
    ChangeRow {
        origin_device_id: "peerx".into(),
        hlc: hlc.into(),
        entity_kind: "asset".into(),
        entity_id: id.into(),
        op: "asset.insert".into(),
        payload_json: serde_json::json!({ "v": 1, "clocks": { "body": hlc }, "state": state })
            .to_string(),
    }
}

fn asset_state(path: &str) -> Value {
    serde_json::json!({
        "file_path": path,
        "mime_type": "image/png",
        "file_name": "forged.png",
        "width": 1,
        "height": 1,
        "size_bytes": 3,
        "created_at": 1,
        "sha256": SHA,
    })
}

/// Файл ассета от пира обязан называться `<свой id>.<ext>` в каноническом
/// виде: иначе ряд может назвать чужой файл (в том числе другим регистром или
/// с точкой в конце — macOS и Windows считают это тем же файлом), и сборка
/// сирот по нему сотрёт чужую картинку. Честный ряд и его повтор проходят.
#[test]
fn an_asset_row_must_name_its_own_canonical_file() {
    let a = Replica::new("a");
    populate(&a);
    let (owner, file_path): (String, String) =
        a.ws.read_blocking(|c| {
            Ok(
                c.query_row("SELECT id, file_path FROM assets LIMIT 1", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?,
            )
        })
        .unwrap();
    assert_eq!(file_path, format!("{owner}.png"));

    let forged = new_id();
    let upper = owner.to_uppercase();
    let refused = [
        // Чужой файл байт в байт.
        (forged.clone(), file_path.clone()),
        // Тот же файл на нечувствительной к регистру ФС.
        (upper.clone(), format!("{upper}.png")),
        (forged.clone(), format!("{upper}.png")),
        (forged.clone(), format!("{owner}.PNG")),
        // Windows отбрасывает точку в конце.
        (forged.clone(), format!("{file_path}.")),
        (forged.clone(), format!("{forged}.png.")),
        // Не свой id, слишком длинное имя, пустой хвост, не UUID.
        (forged.clone(), format!("{forged}.{}", "a".repeat(124))),
        (forged.clone(), format!("{forged}.")),
        (forged.clone(), format!("{}.png", new_id())),
        (forged.clone(), forged.clone()),
        ("pic".to_string(), "pic.png".to_string()),
    ];
    for (counter, (id, path)) in (0u32..).zip(refused) {
        let report = a.apply_rows(vec![peer_asset_row(
            &id,
            &peer_hlc(60_000, counter),
            asset_state(&path),
        )]);
        assert_eq!(report.rejected, 1, "{id} {path}: {report:?}");
    }
    assert_eq!(a.count("SELECT COUNT(*) FROM assets"), 1);

    // Существующий ассет не переезжает на другой файл.
    let report = a.apply_rows(vec![peer_asset_row(
        &owner,
        &peer_hlc(60_000, 100),
        asset_state(&format!("{owner}.jpg")),
    )]);
    assert_eq!(report.rejected, 1, "{report:?}");

    // Повтор ряда того же ассета с тем же файлом применяется.
    let report = a.apply_rows(vec![peer_asset_row(
        &owner,
        &peer_hlc(60_000, 101),
        asset_state(&file_path),
    )]);
    assert_eq!(report.applied, 1, "{report:?}");
    let name: String = a
        .scalar("SELECT file_name FROM assets WHERE id = ?1", &owner)
        .unwrap();
    assert_eq!(name, "forged.png");

    // Хвосты карточек-файлов 0.3.0 (дефис, кириллица) и имя на пределе длины
    // проходят.
    for (counter, tail) in (110u32..).zip(["tar-gz", "пдф", &"a".repeat(123)]) {
        let id = new_id();
        let report = a.apply_rows(vec![peer_asset_row(
            &id,
            &peer_hlc(60_000, counter),
            asset_state(&format!("{id}.{tail}")),
        )]);
        assert_eq!(report.applied, 1, "{tail}: {report:?}");
    }

    // Честный новый ряд проходит, его новая версия в следующем батче — тоже.
    let fresh = new_id();
    for counter in [102, 103] {
        let report = a.apply_rows(vec![peer_asset_row(
            &fresh,
            &peer_hlc(60_000, counter),
            asset_state(&format!("{fresh}.png")),
        )]);
        assert_eq!(report.applied, 1, "{report:?}");
    }
}

/// Восстановление ассета из журнала пропускает отклонённую подделку, даже
/// когда она новее честного ряда: иначе карточка с картинкой не встанет.
#[test]
fn a_restored_asset_skips_a_newer_forged_row() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let fx = populate(&a);
    let rows = a.export_for(&b);
    let (assets, rest): (Vec<ChangeRow>, Vec<ChangeRow>) =
        rows.into_iter().partition(|r| r.entity_kind == "asset");
    let asset = assets[0].entity_id.clone();
    let file_path: String = serde_json::from_str::<Value>(&assets[0].payload_json).unwrap()
        ["state"]["file_path"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(b.apply_rows(assets).pending, 0);
    let forged = b.apply_rows(vec![peer_asset_row(
        &asset,
        &peer_hlc(60_000, 0),
        asset_state(&format!("{}.png", new_id())),
    )]);
    assert_eq!(forged.rejected, 1, "{forged:?}");
    let collected = b
        .apply(Mutation::CollectOrphanedAssets)
        .into_count()
        .unwrap();
    assert_eq!(collected, 1);

    let report = b.apply_rows(rest);
    assert_eq!(report.pending, 0, "{report:?}");
    assert_eq!(report.rejected, 0, "{report:?}");
    assert_eq!(b.board(&fx.board), a.board(&fx.board));
    let stored: String = b
        .scalar("SELECT file_path FROM assets WHERE id = ?1", &asset)
        .unwrap();
    assert_eq!(stored, file_path);
}
