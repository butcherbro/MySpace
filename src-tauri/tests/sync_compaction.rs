//! ADR-0011 amendment 2026-09-30: journal compaction by dominance. Real
//! workspaces in temp dirs; the "transport" is `journal::changes_since` on one
//! replica applied through the other's writer funnel, page by page, as the
//! LAN loop does. Compaction runs only where a test calls [`compact`].
//!
//! The property test runs `COMPACTION_SEEDS` seeds (default 12) from
//! `COMPACTION_SEED` (default 1); a failure prints the seed to rerun:
//!
//!     COMPACTION_SEED=<seed> COMPACTION_SEEDS=1 cargo test --test sync_compaction property

use std::collections::BTreeMap;
use std::path::PathBuf;

use myspace_lib::app::{Workspace, WorkspacePaths};
use myspace_lib::domain::models::{
    CreateChildBoardInput, CreateNoteInput, Frame, MoveBoardInput, MoveCardToBoardInput,
    UpdateCardFrameInput, UpdateNoteInput,
};
use myspace_lib::domain::mutation::Mutation;
use myspace_lib::domain::plain_text::plain_text_to_document;
use myspace_lib::sync::compact::{self, CompactReport};
use myspace_lib::sync::{journal, ChangeRow};
use rusqlite::OptionalExtension;

struct Replica {
    ws: Workspace,
    dir: PathBuf,
}

impl Replica {
    fn new(tag: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("myspace-compact-{tag}-{}", uuid::Uuid::now_v7()));
        let ws = Workspace::open(WorkspacePaths::new(&dir)).unwrap();
        Self { ws, dir }
    }

    fn home(&self) -> String {
        self.ws
            .read_blocking(|c| {
                Ok(c.query_row("SELECT root_board_id FROM workspaces", [], |r| r.get(0))?)
            })
            .unwrap()
    }

    fn try_apply(&self, m: Mutation) -> bool {
        self.ws.apply_blocking(m).is_ok()
    }

    fn apply(&self, m: Mutation) {
        self.ws.apply_blocking(m).unwrap();
    }

    fn strings(&self, sql: &str, arg: &str) -> Vec<String> {
        let (sql, arg) = (sql.to_string(), arg.to_string());
        self.ws
            .read_blocking(move |c| {
                let mut stmt = c.prepare(&sql)?;
                let rows = stmt.query_map([&arg], |r| r.get(0))?;
                Ok(rows.collect::<Result<Vec<String>, _>>()?)
            })
            .unwrap()
    }

    fn count(&self, sql: &str, arg: &str) -> i64 {
        let (sql, arg) = (sql.to_string(), arg.to_string());
        self.ws
            .read_blocking(move |c| Ok(c.query_row(&sql, [&arg], |r| r.get(0))?))
            .unwrap()
    }

    fn revision(&self, table: &str, id: &str) -> Option<i64> {
        let (sql, id) = (
            format!("SELECT revision FROM {table} WHERE id = ?1"),
            id.to_string(),
        );
        self.ws
            .read_blocking(move |c| Ok(c.query_row(&sql, [&id], |r| r.get(0)).optional()?))
            .unwrap()
    }

    fn note_text(&self, card: &str) -> Option<String> {
        self.strings("SELECT plain_text FROM note_cards WHERE card_id = ?1", card)
            .pop()
    }

    fn rows(&self) -> Vec<ChangeRow> {
        self.ws
            .read_blocking(|c| {
                let mut stmt = c.prepare(
                    "SELECT origin_device_id, hlc, entity_kind, entity_id, op, payload_json
                     FROM changes ORDER BY hlc",
                )?;
                let rows = stmt.query_map([], |r| {
                    Ok(ChangeRow {
                        origin_device_id: r.get(0)?,
                        hlc: r.get(1)?,
                        entity_kind: r.get(2)?,
                        entity_id: r.get(3)?,
                        op: r.get(4)?,
                        payload_json: r.get(5)?,
                    })
                })?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
            .unwrap()
    }

    fn journal_len(&self) -> i64 {
        self.count("SELECT COUNT(*) FROM changes WHERE ?1 = ?1", "")
    }

    fn pending(&self) -> i64 {
        self.count("SELECT COUNT(*) FROM pending_changes WHERE ?1 = ?1", "")
    }

    fn copies(&self) -> Vec<String> {
        self.strings(
            "SELECT plain_text FROM note_cards WHERE plain_text LIKE ?1 ORDER BY card_id",
            "Conflict copy%",
        )
    }

    fn compaction_meta(&self) -> Vec<(String, String)> {
        self.ws
            .read_blocking(|c| {
                let mut stmt = c.prepare(
                    "SELECT key, value FROM local_meta WHERE key LIKE 'journal_compact%'
                     OR key = 'journal_vacuum_due' ORDER BY key",
                )?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
            .unwrap()
    }

    /// The synced state, device-local parts removed, Home aliased; conflict
    /// copies by their text only.
    fn state(&self) -> Vec<String> {
        let home = self.home();
        let copies = self.copies();
        self.ws
            .read_blocking(move |c| {
                let alias = |id: Option<String>| match id {
                    Some(id) if id == home => "@home".to_string(),
                    Some(id) => id,
                    None => "-".into(),
                };
                let mut out = Vec::new();
                let mut stmt = c.prepare(
                    "SELECT id, parent_board_id, title, color_token, deleted_at, trash_batch_id
                     FROM boards ORDER BY id",
                )?;
                let boards = stmt.query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<i64>>(4)?,
                        r.get::<_, Option<String>>(5)?,
                    ))
                })?;
                for b in boards {
                    let (id, parent, title, color, deleted, batch) = b?;
                    out.push(format!(
                        "board {} parent={} {title:?} {color:?} {deleted:?} {batch:?}",
                        alias(Some(id)),
                        alias(parent)
                    ));
                }
                let mut stmt = c.prepare(
                    "SELECT c.id, c.board_id, c.kind, c.x, c.y, c.width, c.height, c.z_index,
                            c.unsorted, c.deleted_at, c.trash_batch_id, n.plain_text,
                            n.color_token, p.target_board_id
                     FROM cards c
                     LEFT JOIN note_cards n ON n.card_id = c.id
                     LEFT JOIN board_portal_cards p ON p.card_id = c.id
                     WHERE COALESCE(n.plain_text, '') NOT LIKE 'Conflict copy%'
                     ORDER BY c.id",
                )?;
                let cards = stmt.query_map([], |r| {
                    Ok(format!(
                        "card {} on={} {} {:?} {:?} {:?} {:?} z={} u={} {:?} {:?} {:?} {:?} ->{:?}",
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, f64>(3)?,
                        r.get::<_, f64>(4)?,
                        r.get::<_, f64>(5)?,
                        r.get::<_, f64>(6)?,
                        r.get::<_, i64>(7)?,
                        r.get::<_, i64>(8)?,
                        r.get::<_, Option<i64>>(9)?,
                        r.get::<_, Option<String>>(10)?,
                        r.get::<_, Option<String>>(11)?,
                        r.get::<_, Option<String>>(12)?,
                        r.get::<_, Option<String>>(13)?,
                    ))
                })?;
                for card in cards {
                    let card = card?;
                    // The card's board id is local: alias Home.
                    out.push(card.replace(&home, "@home"));
                }
                out.extend(copies.iter().map(|text| format!("copy {text:?}")));
                out.sort();
                Ok(out)
            })
            .unwrap()
    }
}

impl Drop for Replica {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Equal states; on a difference, only the differing lines are printed.
#[track_caller]
fn assert_same(left: &[String], right: &[String], what: &str) {
    if left != right {
        let only_left: Vec<&String> = left.iter().filter(|l| !right.contains(l)).collect();
        let only_right: Vec<&String> = right.iter().filter(|r| !left.contains(r)).collect();
        panic!("{what}\n only left: {only_left:#?}\n only right: {only_right:#?}");
    }
}

fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

fn frame(x: f64) -> Frame {
    Frame {
        x,
        y: 40.0,
        width: 240.0,
        height: 160.0,
    }
}

fn compact(r: &Replica) -> CompactReport {
    compact::run_blocking(&r.ws).unwrap()
}

/// Pulls what `from` holds and `to` lacks, `page` rows per batch, at most
/// `max_pages` batches (an interrupted pass). Returns the rows moved.
fn pull(from: &Replica, to: &Replica, page: usize, max_pages: usize) -> usize {
    let mut cursors = to.ws.read_blocking(journal::our_cursors).unwrap();
    let mut moved = 0;
    for _ in 0..max_pages {
        let c = cursors.clone();
        let got = from
            .ws
            .read_blocking(move |conn| journal::changes_since(conn, &c, page))
            .unwrap();
        moved += got.rows.len();
        if !got.rows.is_empty() {
            to.apply(Mutation::ApplySyncChanges(got.rows));
        }
        match got.next {
            Some(next) => cursors = next,
            None => break,
        }
    }
    moved
}

fn sync(from: &Replica, to: &Replica) -> usize {
    pull(from, to, 500, usize::MAX)
}

/// Full exchange between every pair until nothing moves (conflict copies
/// travel in a later round than the conflict).
fn settle(replicas: &[&Replica]) {
    for _ in 0..10 {
        let mut moved = 0;
        for from in replicas {
            for to in replicas {
                if !std::ptr::eq(*from, *to) {
                    moved += sync(from, to);
                }
            }
        }
        if moved == 0 {
            return;
        }
    }
    panic!("no convergence after 10 rounds");
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

fn update_note(r: &Replica, card: &str, text: &str) -> bool {
    let Some(revision) = r.revision("cards", card) else {
        return false;
    };
    r.try_apply(Mutation::UpdateNote(UpdateNoteInput {
        id: card.to_string(),
        expected_revision: revision,
        document_json: plain_text_to_document(text),
        acknowledge_corrupt: false,
    }))
}

fn move_card(r: &Replica, card: &str, x: f64) -> bool {
    let Some(revision) = r.revision("cards", card) else {
        return false;
    };
    r.try_apply(Mutation::MoveCard(UpdateCardFrameInput {
        id: card.to_string(),
        expected_revision: revision,
        frame: frame(x),
    }))
}

fn create_board(r: &Replica, parent: &str, title: &str) -> Option<String> {
    let id = new_id();
    r.try_apply(Mutation::CreateChildBoard(CreateChildBoardInput {
        parent_board_id: parent.to_string(),
        board_id: id.clone(),
        portal_card_id: new_id(),
        frame: frame(500.0),
        title: title.to_string(),
    }))
    .then_some(id)
}

fn move_board(r: &Replica, board: &str, parent: &str) -> bool {
    let (Some(board_rev), Some(portal)) = (
        r.revision("boards", board),
        r.strings(
            "SELECT card_id FROM board_portal_cards WHERE target_board_id = ?1",
            board,
        )
        .pop(),
    ) else {
        return false;
    };
    let Some(portal_rev) = r.revision("cards", &portal) else {
        return false;
    };
    r.try_apply(Mutation::MoveBoard(MoveBoardInput {
        board_id: board.to_string(),
        expected_board_revision: board_rev,
        expected_portal_revision: portal_rev,
        target_parent_board_id: parent.to_string(),
        frame: frame(700.0),
    }))
}

fn empty_trash(r: &Replica) -> bool {
    r.try_apply(Mutation::EmptyTrash {
        confirmation: "EMPTY".into(),
    })
}

// ---- property test ------------------------------------------------------------

/// xorshift64*, seeded through splitmix64 (reproducible, no dependency).
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        Rng((z ^ (z >> 31)) | 1)
    }
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        (!items.is_empty()).then(|| &items[self.below(items.len())])
    }
}

/// Every row any replica ever held (compaction only deletes, so reading a
/// replica before each compaction and at the end sees them all).
fn archive(r: &Replica, all: &mut BTreeMap<(String, String), ChangeRow>) {
    for row in r.rows() {
        all.insert((row.origin_device_id.clone(), row.hlc.clone()), row);
    }
}

/// Three replicas, random writes, exchanges with random page sizes that may
/// stop early, and compaction at random points. After a full exchange all
/// replicas agree, conflict copies included, and agree with a fresh replica
/// that replays every row ever written (the uncompacted journal) and with one
/// bootstrapped from a compacted journal: compaction changed nothing but the
/// journal's size. `compaction: false` runs the same script without it.
fn property_case(seed: u64, compaction: bool) {
    let mut rng = Rng::new(seed);
    let replicas = [Replica::new("p0"), Replica::new("p1"), Replica::new("p2")];
    let home: Vec<String> = replicas.iter().map(Replica::home).collect();
    // Script-level pools: ids the ops pick from (conflict copies excluded).
    let mut notes: Vec<String> = Vec::new();
    let mut boards: Vec<String> = Vec::new();
    let mut all = BTreeMap::new();
    let mut compactions = 0;

    for step in 0..70 {
        let i = rng.below(3);
        let r = &replicas[i];
        // Boards this replica holds live (Home is `None`).
        let live_boards: Vec<Option<String>> = std::iter::once(None)
            .chain(
                boards
                    .iter()
                    .filter(|b| {
                        r.count(
                            "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
                            b,
                        ) == 1
                    })
                    .cloned()
                    .map(Some),
            )
            .collect();
        let local = |b: &Option<String>| b.clone().unwrap_or_else(|| home[i].clone());
        let text = format!("s{seed} step {step} on {i}");
        match rng.below(100) {
            0..=14 => {
                let board = local(rng.pick(&live_boards).unwrap());
                notes.push(create_note(r, &board, &text));
            }
            15..=34 => {
                if let Some(note) = rng.pick(&notes) {
                    update_note(r, note, &text);
                }
            }
            35..=44 => {
                if let Some(note) = rng.pick(&notes) {
                    move_card(r, note, rng.below(1000) as f64);
                }
            }
            45..=51 => {
                if let (Some(note), Some(board)) = (rng.pick(&notes), rng.pick(&live_boards)) {
                    let target = local(board);
                    if let Some(revision) = r.revision("cards", note) {
                        r.try_apply(Mutation::MoveCardToBoard(MoveCardToBoardInput {
                            id: note.clone(),
                            expected_revision: revision,
                            target_board_id: target,
                            frame: None,
                        }));
                    }
                }
            }
            52..=58 => {
                let parent = local(rng.pick(&live_boards).unwrap());
                if let Some(board) = create_board(r, &parent, &text) {
                    boards.push(board);
                }
            }
            59..=62 => {
                if let Some(board) = rng.pick(&boards) {
                    r.try_apply(Mutation::RenameBoard {
                        board_id: board.clone(),
                        title: text.clone(),
                    });
                }
            }
            63..=65 => {
                // Only to Home: concurrent moves into each other's subtree
                // form a cycle, which replay resolves per replica.
                if let Some(board) = rng.pick(&boards) {
                    move_board(r, board, &home[i]);
                }
            }
            66..=69 => {
                if let Some(note) = rng.pick(&notes) {
                    r.try_apply(Mutation::TrashNote {
                        card_id: note.clone(),
                    });
                }
            }
            70..=71 => {
                if let Some(board) = rng.pick(&boards) {
                    r.try_apply(Mutation::TrashBoard {
                        board_id: board.clone(),
                    });
                }
            }
            72..=74 => {
                let batches = r.strings(
                    "SELECT trash_batch_id FROM cards WHERE trash_batch_id IS NOT NULL AND ?1 = ?1
                     UNION SELECT trash_batch_id FROM boards WHERE trash_batch_id IS NOT NULL",
                    "",
                );
                if let Some(batch) = rng.pick(&batches) {
                    r.try_apply(Mutation::RestoreTrashBatch {
                        batch_id: batch.clone(),
                    });
                }
            }
            75..=76 => {
                // A purge racing a move of the purged board's content is
                // order-dependent in replay with or without compaction (a
                // cascade purges what is on the board when the purge
                // arrives), so purges happen between settled replicas.
                let refs: Vec<&Replica> = replicas.iter().collect();
                settle(&refs);
                empty_trash(r);
                settle(&refs);
            }
            77..=78 => {
                // Purge между НЕ-settled репликами: гонка purge с переносом
                // содержимого может разойтись и без компакции, такие сиды
                // исключает тест (см. ниже), а не этот сценарий.
                empty_trash(r);
            }
            79..=91 => {
                let j = (i + 1 + rng.below(2)) % 3;
                let page = 1 + rng.below(12);
                let pages = if rng.below(3) == 0 {
                    1 + rng.below(3)
                } else {
                    usize::MAX
                };
                pull(&replicas[j], r, page, pages);
            }
            _ => {
                if compaction {
                    archive(r, &mut all);
                    compact(r);
                    compactions += 1;
                }
            }
        }
    }

    for r in &replicas {
        archive(r, &mut all);
    }
    let refs: Vec<&Replica> = replicas.iter().collect();
    settle(&refs);
    for r in &replicas {
        archive(r, &mut all);
        if compaction {
            compact(r);
        }
    }
    settle(&refs);

    let expected = replicas[0].state();
    for (i, r) in replicas.iter().enumerate() {
        assert_eq!(r.pending(), 0, "seed {seed}: replica {i} has parked rows");
        assert_same(
            &r.state(),
            &expected,
            &format!("seed {seed}: replica {i} differs"),
        );
    }

    // Полный журнал сравнивается без conflict copies: компакция вправе
    // оставить реплики с меньшим числом копий, чем дал бы полный журнал
    // (ADR-0011). Свежая реплика из сжатого журнала обязана совпасть целиком.
    let full = Replica::new("full");
    full.apply(Mutation::ApplySyncChanges(all.into_values().collect()));
    assert_eq!(full.pending(), 0, "seed {seed}: full replay parked rows");
    assert_same(
        &without_copies(full.state()),
        &without_copies(expected.clone()),
        &format!(
            "seed {seed}: the uncompacted journal gives another state ({compactions} compactions)"
        ),
    );

    let fresh = Replica::new("fresh");
    pull(
        &replicas[rng.below(3)],
        &fresh,
        1 + rng.below(50),
        usize::MAX,
    );
    assert_eq!(fresh.pending(), 0, "seed {seed}: bootstrap parked rows");
    assert_same(
        &fresh.state(),
        &expected,
        &format!("seed {seed}: bootstrap from a compacted journal differs"),
    );
}

fn without_copies(state: Vec<String>) -> Vec<String> {
    state
        .into_iter()
        .filter(|l| !l.starts_with("copy "))
        .collect()
}

/// A seed that fails with compaction counts only when the same script passes
/// without it: purges between replicas that are not settled are
/// order-dependent in replay itself (a cascade purges what is on the board
/// when the purge arrives, a row placed on a purged board parks), and such a
/// seed is skipped, not failed.
#[test]
fn property_compacted_replicas_converge_like_the_full_journal() {
    let env = |name: &str, default: u64| {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    };
    let first = env("COMPACTION_SEED", 1);
    let count = env("COMPACTION_SEEDS", 12);
    let started = std::time::Instant::now();
    let mut skipped = Vec::new();
    for seed in first..first + count {
        let result = std::panic::catch_unwind(|| property_case(seed, true));
        if let Err(panic) = result {
            if std::panic::catch_unwind(|| property_case(seed, false)).is_err() {
                skipped.push(seed);
                continue;
            }
            eprintln!("property test failed: COMPACTION_SEED={seed} COMPACTION_SEEDS=1");
            std::panic::resume_unwind(panic);
        }
    }
    eprintln!(
        "property test: {count} seeds from {first} in {:.1}s, skipped (fail without compaction too): {skipped:?}",
        started.elapsed().as_secs_f64()
    );
}

// ---- targeted cases -------------------------------------------------------------

/// A varied history on A: boards, notes, edits, moves, trash and restore.
fn history(a: &Replica) -> (String, Vec<String>) {
    let home = a.home();
    let board = create_board(a, &home, "Project").unwrap();
    let child = create_board(a, &board, "Child").unwrap();
    let mut notes = Vec::new();
    for n in 0..6 {
        let on = if n % 2 == 0 { &board } else { &child };
        let note = create_note(a, on, &format!("note {n}"));
        for e in 0..4 {
            update_note(a, &note, &format!("note {n} edit {e}"));
            move_card(a, &note, (n * 10 + e) as f64);
        }
        notes.push(note);
    }
    a.try_apply(Mutation::RenameBoard {
        board_id: child.clone(),
        title: "Renamed".into(),
    });
    a.try_apply(Mutation::TrashNote {
        card_id: notes[0].clone(),
    });
    a.try_apply(Mutation::TrashNote {
        card_id: notes[1].clone(),
    });
    let batch = a
        .strings("SELECT trash_batch_id FROM cards WHERE id = ?1", &notes[1])
        .pop()
        .unwrap();
    a.apply(Mutation::RestoreTrashBatch { batch_id: batch });
    (board, notes)
}

#[test]
fn a_replica_bootstrapped_from_a_compacted_journal_equals_one_from_the_full_journal() {
    let a = Replica::new("a");
    history(&a);
    let full_rows = a.rows();

    let report = compact(&a);
    assert!(report.done);
    assert!(report.deleted > 0, "{report:?}");
    assert!(a.journal_len() < full_rows.len() as i64);

    let from_full = Replica::new("full");
    from_full.apply(Mutation::ApplySyncChanges(full_rows));
    let from_compacted = Replica::new("compacted");
    sync(&a, &from_compacted);

    assert_eq!(from_compacted.pending(), 0);
    assert_eq!(from_compacted.state(), from_full.state());
    assert_eq!(from_compacted.state(), a.state());
    // Every row the compacted replica received is new to the full one: the
    // compacted journal is a subset of the full journal.
    assert_eq!(sync(&a, &from_full), 0);
}

#[test]
fn compaction_is_idempotent() {
    let a = Replica::new("a");
    history(&a);
    let first = compact(&a);
    assert!(first.done && first.deleted > 0, "{first:?}");
    let (rows, meta) = (a.rows(), a.compaction_meta());

    let second = compact(&a);
    assert_eq!(second.deleted, 0, "{second:?}");
    assert_eq!(second.entities, 0, "nothing new: {second:?}");
    assert!(second.done);
    assert_eq!(a.rows(), rows);
    assert_eq!(a.compaction_meta(), meta, "a no-op run writes nothing");
}

/// Resuming after a chunk: a run over more rows than one chunk ends where a
/// single run would.
#[test]
fn a_run_larger_than_one_chunk_resumes_to_the_same_result() {
    let a = Replica::new("a");
    let home = a.home();
    let notes: Vec<String> = (0..40)
        .map(|n| create_note(&a, &home, &format!("n{n}")))
        .collect();
    for round in 0..60 {
        for note in &notes {
            move_card(&a, note, round as f64);
        }
    }
    assert!(a.journal_len() > compact::CHUNK_ROWS as i64);
    let mut chunks = 0;
    loop {
        let chunk =
            a.ws.apply_blocking(Mutation::CompactJournal)
                .unwrap()
                .into_compaction()
                .unwrap();
        chunks += 1;
        if chunk.done {
            break;
        }
    }
    assert!(chunks >= 2, "{chunks}");
    // Per note: its newest move, and the create (it set the body clock).
    assert_eq!(
        a.count(
            "SELECT COUNT(*) FROM changes WHERE entity_kind = 'card' AND ?1 = ?1",
            ""
        ),
        2 * notes.len() as i64
    );
}

#[test]
fn autosaves_synced_back_after_compaction_give_no_conflict_copy() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let note = create_note(&a, &a.home(), "from A");
    sync(&a, &b);
    for n in 0..3 {
        assert!(update_note(&b, &note, &format!("B autosave {n}")));
    }
    let report = compact(&b);
    assert!(report.deleted > 0, "{report:?}");

    sync(&b, &a);
    assert_eq!(a.note_text(&note).as_deref(), Some("B autosave 2"));
    assert!(a.copies().is_empty(), "{:?}", a.copies());

    compact(&a);
    let c = Replica::new("c");
    sync(&a, &c);
    settle(&[&a, &b, &c]);
    for r in [&a, &b, &c] {
        assert!(r.copies().is_empty(), "{:?}", r.copies());
        assert_eq!(r.note_text(&note).as_deref(), Some("B autosave 2"));
    }
}

#[test]
fn a_concurrent_edit_whose_head_row_is_a_move_gives_exactly_one_copy() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let note = create_note(&a, &a.home(), "base");
    sync(&a, &b);
    assert!(update_note(&a, &note, "A offline"));
    assert!(update_note(&b, &note, "B offline"));
    assert!(move_card(&b, &note, 333.0));
    compact(&a);
    compact(&b);

    settle(&[&a, &b]);
    let copies = a.copies();
    assert_eq!(copies.len(), 1, "{copies:?}");
    assert_eq!(b.copies(), copies);
    assert_eq!(a.state(), b.state());
    let x: i64 = a.count("SELECT CAST(x AS INTEGER) FROM cards WHERE id = ?1", &note);
    assert_eq!(x, 333, "the move is kept");
}

#[test]
fn a_purged_note_is_never_resurrected_and_its_text_is_not_served() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let home = a.home();
    let note = create_note(&a, &home, "secret v1");
    sync(&a, &b);
    update_note(&a, &note, "secret v2");
    // B edits a note A is about to purge: the late edit.
    assert!(update_note(&b, &note, "late edit on B"));
    a.apply(Mutation::TrashNote {
        card_id: note.clone(),
    });
    assert!(empty_trash(&a));
    compact(&a);

    let rows = a.strings(
        "SELECT op FROM changes WHERE entity_id = ?1 ORDER BY hlc",
        &note,
    );
    assert_eq!(rows, ["purge"], "only the purge row is kept");
    let leaked = a.count(
        "SELECT COUNT(*) FROM changes WHERE payload_json LIKE ?1",
        "%secret%",
    );
    assert_eq!(leaked, 0);

    // A new device learns only the tombstone, then gets B's late edit.
    let c = Replica::new("c");
    sync(&a, &c);
    sync(&b, &c);
    assert!(c.note_text(&note).is_none());
    assert_eq!(
        c.count("SELECT COUNT(*) FROM purged WHERE entity_id = ?1", &note),
        1
    );
    settle(&[&a, &b, &c]);
    for r in [&a, &b, &c] {
        assert!(r.note_text(&note).is_none());
        compact(r);
    }
    settle(&[&a, &b, &c]);
    for r in [&a, &b, &c] {
        assert!(r.note_text(&note).is_none());
    }
}

/// A card only ever purged by a cascade (created on a board another device
/// purged without knowing it) has no purge row of its own: compaction keeps
/// its rows and its board's, so a device bootstrapped later still purges it.
#[test]
fn a_card_purged_only_by_a_cascade_stays_purged_after_compaction() {
    let (a, c) = (Replica::new("a"), Replica::new("c"));
    let board = create_board(&a, &a.home(), "Doomed").unwrap();
    sync(&a, &c);
    let orphan = create_note(&c, &board, "made on C only");
    assert!(move_card(&c, &orphan, 10.0));
    a.apply(Mutation::TrashBoard {
        board_id: board.clone(),
    });
    assert!(empty_trash(&a));
    sync(&a, &c);
    assert!(c.note_text(&orphan).is_none(), "the cascade purged it");
    let rows_before = c.count("SELECT COUNT(*) FROM changes WHERE entity_id = ?1", &orphan);
    compact(&a);
    compact(&c);
    assert_eq!(
        c.count("SELECT COUNT(*) FROM changes WHERE entity_id = ?1", &orphan),
        rows_before
    );

    let n = Replica::new("n");
    sync(&c, &n);
    assert!(n.note_text(&orphan).is_none());
    assert_eq!(
        n.count("SELECT COUNT(*) FROM purged WHERE entity_id = ?1", &orphan),
        1
    );
    settle(&[&a, &c, &n]);
    assert_same(&n.state(), &c.state(), "bootstrapped from C");
    assert_same(&a.state(), &c.state(), "A and C");
}

/// Compaction keeps every board's create row, and replay still does not
/// depend on it: here each board's surviving row is a move under the next
/// one, written deepest first, so each retry pass can only place one more
/// level. The old cap of 8 passes left the deep end parked.
#[test]
fn boards_nested_deeper_than_the_old_retry_cap_arrive_in_one_batch() {
    const DEPTH: usize = 20;
    let a = Replica::new("a");
    let home = a.home();
    let boards: Vec<String> = (0..DEPTH)
        .map(|n| create_board(&a, &home, &format!("level {n}")).unwrap())
        .collect();
    for n in (1..DEPTH).rev() {
        assert!(move_board(&a, &boards[n], &boards[n - 1]));
    }
    compact(&a);
    assert_eq!(
        a.count(
            "SELECT COUNT(*) FROM changes WHERE entity_kind = 'board' AND op = ?1",
            "board.create_child"
        ),
        DEPTH as i64
    );

    let b = Replica::new("b");
    let mut rows = {
        let c = std::collections::BTreeMap::new();
        a.ws.read_blocking(move |conn| journal::changes_since(conn, &c, journal::MAX_PAGE))
            .unwrap()
    };
    // Без строк создания уровней 1.. доски приходят от ребёнка к родителю.
    rows.rows.retain(|r| {
        r.entity_kind != "board" || r.op != "board.create_child" || r.entity_id == boards[0]
    });
    assert!(rows.next.is_none());
    b.apply(Mutation::ApplySyncChanges(rows.rows));
    assert_eq!(b.pending(), 0);
    assert_eq!(b.state(), a.state());
    let deepest = b
        .strings(
            "SELECT parent_board_id FROM boards WHERE id = ?1",
            &boards[DEPTH - 1],
        )
        .pop();
    assert_eq!(deepest.as_deref(), Some(boards[DEPTH - 2].as_str()));
}

/// A row compaction deleted here is not taken back when a peer that still
/// has it offers it again.
#[test]
fn a_compacted_row_offered_again_is_a_duplicate() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let note = create_note(&a, &a.home(), "one");
    update_note(&a, &note, "two");
    let full = a.rows();
    sync(&a, &b);
    let deleted = compact(&b).deleted;
    assert!(deleted > 0);
    let before = (b.rows(), b.state());

    let report =
        b.ws.apply_blocking(Mutation::ApplySyncChanges(full.clone()))
            .unwrap()
            .into_sync_report()
            .unwrap();
    assert_eq!(report.duplicates, full.len(), "{report:?}");
    assert_eq!((b.rows(), b.state()), before);
}

/// R2's grace: once the cross-device edit is older than G, its lineage rows
/// go, even though the note itself never changes again.
#[test]
fn lineage_rows_go_once_their_grace_ran_out() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let note = create_note(&a, &a.home(), "from A");
    // A's create is not A's newest row (R2 keeps that one).
    create_note(&a, &a.home(), "another");
    sync(&a, &b);
    assert!(update_note(&b, &note, "B edit 1"));
    assert!(move_card(&b, &note, 50.0));
    compact(&b);
    let kept = b.count("SELECT COUNT(*) FROM changes WHERE entity_id = ?1", &note);
    assert_eq!(kept, 3, "A's create, B's cross-device edit, B's move");

    // Another row makes B's move no longer its origin's head.
    create_note(&b, &b.home(), "later");
    // A writer connection of its own, as the app's would be, 91 days on.
    let later = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + compact::LINEAGE_GRACE_MS
        + 86_400_000;
    let conn = rusqlite::Connection::open(b.ws.paths().db_path()).unwrap();
    conn.execute_batch("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE")
        .unwrap();
    let mut total = 0;
    loop {
        let chunk = compact::compact_chunk(&conn, later).unwrap();
        total += chunk.deleted;
        if chunk.done {
            break;
        }
    }
    conn.execute_batch("COMMIT").unwrap();
    assert_eq!(total, 1);
    // A's create (the edit's prev) goes; the edit stays while it set the
    // current body clock, and the move is the newest image.
    let ops = b.strings(
        "SELECT op FROM changes WHERE entity_id = ?1 ORDER BY hlc",
        &note,
    );
    assert_eq!(ops, ["card.update_note", "card.move"]);
}

/// Moves `card` to `board` (a board change, not a frame move).
fn move_to_board(r: &Replica, card: &str, board: &str) {
    let revision = r.revision("cards", card).unwrap();
    r.apply(Mutation::MoveCardToBoard(MoveCardToBoardInput {
        id: card.to_string(),
        expected_revision: revision,
        target_board_id: board.to_string(),
        frame: None,
    }));
}

/// A kept row can carry a stale board: B edits a note without having seen
/// A move it off board X. R2 keeps that edit (it set the body clock) while a
/// later frame move dominates the move itself. The move must stay, or a
/// replica bootstrapped from A creates the note on X and loses it to X's
/// purge.
#[test]
fn a_move_before_a_kept_row_with_a_stale_board_is_kept() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let board_x = create_board(&a, &a.home(), "X").unwrap();
    let board_y = create_board(&a, &a.home(), "Y").unwrap();
    sync(&a, &b);
    let note = create_note(&b, &board_x, "v0");
    sync(&b, &a);
    move_to_board(&a, &note, &board_y);
    std::thread::sleep(std::time::Duration::from_millis(5));
    assert!(update_note(&b, &note, "typed on B"));
    settle(&[&a, &b]);
    a.apply(Mutation::TrashBoard { board_id: board_x });
    assert!(empty_trash(&a));
    settle(&[&a, &b]);
    std::thread::sleep(std::time::Duration::from_millis(5));
    assert!(move_card(&a, &note, 42.0));
    settle(&[&a, &b]);
    let full_rows = a.rows();
    compact(&a);

    let full = Replica::new("full");
    full.apply(Mutation::ApplySyncChanges(full_rows));
    assert_eq!(full.note_text(&note).as_deref(), Some("typed on B"));
    let fresh = Replica::new("fresh");
    sync(&a, &fresh);
    assert_eq!(fresh.note_text(&note).as_deref(), Some("typed on B"));
    assert_same(&fresh.state(), &a.state(), "bootstrapped from compacted A");
}

/// B edits note K twice around A's rename of its board X; the rename
/// dominates X's creation row. Without that row a fresh replica creates X
/// with the rename's HLC, newer than K's creation: that row parks, replays
/// after B's edits and must not read as a concurrent edit.
fn edits_around_a_board_rename() -> (Replica, Replica, String, String) {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let board_x = create_board(&a, &a.home(), "X").unwrap();
    let note = create_note(&a, &board_x, "v1");
    sync(&a, &b);
    assert!(update_note(&b, &note, "v2"));
    std::thread::sleep(std::time::Duration::from_millis(3));
    a.apply(Mutation::RenameBoard {
        board_id: board_x.clone(),
        title: "X2".into(),
    });
    std::thread::sleep(std::time::Duration::from_millis(3));
    assert!(update_note(&b, &note, "v3"));
    sync(&b, &a);
    sync(&a, &b);
    (a, b, board_x, note)
}

#[test]
fn a_board_keeps_its_creation_row_and_a_fresh_replica_gets_no_extra_copy() {
    let (a, b, _, note) = edits_around_a_board_rename();
    compact(&a);
    let fresh = Replica::new("fresh");
    sync(&a, &fresh);
    assert_eq!(fresh.pending(), 0);
    assert_eq!(fresh.note_text(&note).as_deref(), Some("v3"));
    assert!(fresh.copies().is_empty(), "copies: {:?}", fresh.copies());
    assert_same(&fresh.state(), &b.state(), "bootstrapped from compacted A");
}

#[test]
fn a_note_row_parked_behind_its_board_is_not_a_concurrent_edit() {
    let (a, b, board_x, note) = edits_around_a_board_rename();
    // Журнал без строки создания X — так его сжимала прежняя компакция.
    let creation = a
        .rows()
        .into_iter()
        .filter(|r| r.entity_id == board_x)
        .min_by(|l, r| l.hlc.cmp(&r.hlc))
        .unwrap();
    let rows: Vec<ChangeRow> = a
        .rows()
        .into_iter()
        .filter(|r| r.hlc != creation.hlc)
        .collect();
    let fresh = Replica::new("fresh");
    fresh.apply(Mutation::ApplySyncChanges(rows));
    assert_eq!(fresh.pending(), 0);
    assert_eq!(fresh.note_text(&note).as_deref(), Some("v3"));
    assert!(fresh.copies().is_empty(), "copies: {:?}", fresh.copies());
    assert_same(&fresh.state(), &b.state(), "replayed without X's creation");
}

/// The same for a board's parent: B renames board S without having seen A
/// move it from P to Q; B's rename is its origin head (kept), A's later
/// rename dominates the move.
#[test]
fn a_board_move_before_a_kept_row_with_a_stale_parent_is_kept() {
    let (a, b) = (Replica::new("a"), Replica::new("b"));
    let home = a.home();
    let p = create_board(&a, &home, "P").unwrap();
    let q = create_board(&a, &home, "Q").unwrap();
    sync(&a, &b);
    let s = create_board(&b, &p, "S").unwrap();
    sync(&b, &a);
    assert!(move_board(&a, &s, &q));
    std::thread::sleep(std::time::Duration::from_millis(5));
    assert!(b.try_apply(Mutation::RenameBoard {
        board_id: s.clone(),
        title: "renamed on B".into(),
    }));
    settle(&[&a, &b]);
    a.apply(Mutation::TrashBoard { board_id: p });
    assert!(empty_trash(&a));
    settle(&[&a, &b]);
    std::thread::sleep(std::time::Duration::from_millis(5));
    assert!(a.try_apply(Mutation::RenameBoard {
        board_id: s.clone(),
        title: "renamed on A".into(),
    }));
    settle(&[&a, &b]);
    let full_rows = a.rows();
    compact(&a);

    let parent_of = |r: &Replica| {
        r.strings("SELECT parent_board_id FROM boards WHERE id = ?1", &s)
            .pop()
    };
    let full = Replica::new("full");
    full.apply(Mutation::ApplySyncChanges(full_rows));
    assert_eq!(parent_of(&full).as_deref(), Some(q.as_str()));
    let fresh = Replica::new("fresh");
    sync(&a, &fresh);
    assert_eq!(parent_of(&fresh).as_deref(), Some(q.as_str()));
    assert_same(&fresh.state(), &a.state(), "bootstrapped from compacted A");
}

/// An unreadable floor refuses compaction: resetting it to empty would let
/// the chunk overwrite it with only its own deletions.
#[test]
fn an_unreadable_floor_refuses_compaction() {
    let a = Replica::new("a");
    history(&a);
    let conn = rusqlite::Connection::open(a.ws.paths().db_path()).unwrap();
    conn.execute(
        "INSERT INTO local_meta (key, value) VALUES (?1, '{not json')",
        [compact::FLOOR_KEY],
    )
    .unwrap();
    drop(conn);
    let rows = a.rows();
    assert!(a.ws.apply_blocking(Mutation::CompactJournal).is_err());
    assert_eq!(a.rows(), rows, "nothing deleted");
    assert_eq!(
        a.strings(
            "SELECT value FROM local_meta WHERE key = ?1",
            compact::FLOOR_KEY
        ),
        ["{not json"]
    );
}
