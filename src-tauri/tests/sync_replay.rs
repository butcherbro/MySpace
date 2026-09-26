//! ADR-0011 S1 + S2: the change journal and the replay engine, end to end on
//! real workspaces in temp dirs (distinct data dirs → distinct device ids).
//! The "transport" here is a function call: export rows from one workspace
//! with the other's cursors, apply them through the other's writer funnel.

use std::collections::BTreeMap;
use std::path::PathBuf;

use myspace_lib::app::{Workspace, WorkspacePaths};
use myspace_lib::domain::models::{
    AssetDto, CardDto, CreateBoardShortcutInput, CreateFilesystemAliasInput, CreateImageCardInput,
    CreateLinkBatchInput, CreateNoteInput, Frame, LinkBatchItem, UpdateCardFrameInput,
    UpdateNoteInput,
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
            for key in ["revision", "viewport", "local", "originDeviceName"] {
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
    Fixture {
        board,
        child,
        note,
        image,
        alias,
    }
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
    let changes_before: i64 = b
        .scalar("SELECT COUNT(*) FROM changes WHERE ?1 = ?1", "x")
        .unwrap();

    let report = b.apply_rows(rows.clone());
    assert_eq!(report.duplicates, rows.len());
    assert_eq!(report.applied, 0);
    assert!(report.touched_boards.is_empty());
    assert_eq!(
        (b.board(&fx.board), b.revision(&fx.note), b.cursors()),
        before
    );
    let changes_after: i64 = b
        .scalar("SELECT COUNT(*) FROM changes WHERE ?1 = ?1", "x")
        .unwrap();
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
    let count = |r: &Replica| -> i64 {
        r.scalar("SELECT COUNT(*) FROM changes WHERE ?1 = ?1", "x")
            .unwrap()
    };
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
