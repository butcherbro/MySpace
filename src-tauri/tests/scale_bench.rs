//! Scale benchmarks: a 100 000-change journal, a 50 000-card database, 2 GiB
//! and 20 000-file asset sets. Every test is `#[ignore]` (minutes of work and
//! gigabytes of temp data); run one at a time in release:
//!
//!     cargo test --release --test scale_bench <name> -- --ignored --nocapture --test-threads=1
//!
//! Temp data goes under `$SCALE_TMP` (default: the system temp dir) and is
//! removed when the test ends.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use myspace_lib::app::{Workspace, WorkspacePaths};
use myspace_lib::db;
use myspace_lib::db::backup;
use myspace_lib::domain::models::{
    CreateChildBoardInput, CreateNoteInput, Frame, UpdateCardFrameInput, UpdateNoteInput,
};
use myspace_lib::domain::mutation::Mutation;
use myspace_lib::repositories::workspace_repository as repo;
use myspace_lib::sync::{compact, journal};
use rusqlite::{params, Connection};
use serde_json::json;

/// Self-cleaning temp dir (no tempfile dependency in this crate).
struct Tmp(PathBuf);
impl Tmp {
    fn new(tag: &str) -> Tmp {
        let base = match std::env::var("SCALE_TMP") {
            Ok(p) => PathBuf::from(p),
            Err(_) => std::env::temp_dir(),
        };
        let dir = base.join(format!("scalebench-{tag}-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % (n as u64)) as usize
    }
}

const WORDS: [&str; 30] = [
    "alpha",
    "budget",
    "canvas",
    "delta",
    "engine",
    "forest",
    "garden",
    "harbor",
    "island",
    "jungle",
    "kernel",
    "lantern",
    "meadow",
    "nebula",
    "orbit",
    "planet",
    "quartz",
    "river",
    "saturn",
    "tunnel",
    "umbra",
    "valley",
    "willow",
    "xenon",
    "yonder",
    "zephyr",
    "дорога",
    "книга",
    "мысль",
    "работа",
];

fn words(rng: &mut Rng, n: usize) -> String {
    let mut out = String::new();
    for i in 0..n {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(WORDS[rng.below(WORDS.len())]);
    }
    out
}

fn doc(text: &str) -> serde_json::Value {
    json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]})
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn stats(label: &str, v: &[Duration]) {
    let mut s = v.to_vec();
    s.sort();
    let p = |q: f64| s[((s.len() as f64 - 1.0) * q).round() as usize];
    let total: Duration = s.iter().sum();
    println!(
        "{label}: n={} p50={:.3}ms p95={:.3}ms p99={:.3}ms max={:.3}ms mean={:.3}ms total={:.2}s",
        s.len(),
        ms(p(0.5)),
        ms(p(0.95)),
        ms(p(0.99)),
        ms(*s.last().unwrap()),
        ms(total) / s.len() as f64,
        total.as_secs_f64()
    );
}

// ---- raw SQL seeding (valid on the v18 schema and on head) -----------------------

fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

fn ws_and_home(conn: &Connection) -> (String, String) {
    conn.query_row(
        "SELECT id, root_board_id FROM workspaces LIMIT 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

fn add_assets(conn: &Connection, n: usize) -> Vec<String> {
    let mut ids = Vec::with_capacity(n);
    for i in 0..n {
        let id = new_id();
        conn.prepare_cached("INSERT INTO assets (id, file_path, mime_type, file_name, size_bytes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").unwrap()
            .execute(params![id, format!("{id}.png"), "image/png", format!("img-{i}.png"), 250_000i64, 1_700_000_000_000i64]).unwrap();
        ids.push(id);
    }
    ids
}

fn add_card_row(conn: &Connection, id: &str, board: &str, kind: &str, i: usize, rng: &mut Rng) {
    conn.prepare_cached("INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 240.0, 120.0, ?6, ?7, ?7)").unwrap()
        .execute(params![id, board, kind, rng.below(4000) as f64, rng.below(4000) as f64, i as i64, 1_700_000_000_000i64 + i as i64]).unwrap();
}

/// One card of the realistic mix: 75% note, 10% link (embed), 10% image, 5% file.
fn add_one_card(
    conn: &Connection,
    board: &str,
    i: usize,
    doc_words: usize,
    assets: &[String],
    rng: &mut Rng,
) {
    let id = new_id();
    let roll = rng.below(100);
    if roll < 75 {
        add_card_row(conn, &id, board, "note", i, rng);
        let text = words(rng, doc_words);
        conn.prepare_cached(
            "INSERT INTO note_cards (card_id, document_json, plain_text) VALUES (?1, ?2, ?3)",
        )
        .unwrap()
        .execute(params![id, doc(&text).to_string(), text])
        .unwrap();
    } else if roll < 85 {
        add_card_row(conn, &id, board, "embed", i, rng);
        let asset = &assets[rng.below(assets.len())];
        let desc = words(rng, 12);
        conn.prepare_cached("INSERT INTO embed_cards (card_id, source_url, display_url, site_name, title, provider, description_json, description_plain_text, asset_id, favicon_asset_id, preview_origin, metadata_status, description_origin) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)").unwrap()
            .execute(params![id, format!("https://example.com/{i}/{}", words(rng, 2).replace(" ", "-")), format!("example.com/{i}"), "Example", words(rng, 5), "web", doc(&desc).to_string(), desc, asset, asset, "fetched", "ready", "site"]).unwrap();
    } else if roll < 95 {
        add_card_row(conn, &id, board, "image", i, rng);
        let cap = words(rng, 4);
        conn.prepare_cached("INSERT INTO image_cards (card_id, asset_id, caption_json, caption_plain_text) VALUES (?1, ?2, ?3, ?4)").unwrap()
            .execute(params![id, assets[rng.below(assets.len())], doc(&cap).to_string(), cap]).unwrap();
    } else {
        add_card_row(conn, &id, board, "file", i, rng);
        conn.prepare_cached("INSERT INTO file_cards (card_id, asset_id, mime_type, preview_text, source_path) VALUES (?1, ?2, ?3, ?4, ?5)").unwrap()
            .execute(params![id, assets[rng.below(assets.len())], "application/pdf", words(rng, 30), "/Users/x/doc.pdf"]).unwrap();
    }
}

fn add_cards(
    conn: &Connection,
    boards: &[String],
    n: usize,
    doc_words: usize,
    assets: &[String],
    rng: &mut Rng,
) {
    for i in 0..n {
        let board = boards[rng.below(boards.len())].clone();
        add_one_card(conn, &board, i, doc_words, assets, rng);
    }
}

/// A child board with its primary portal card on the parent.
fn add_child_board(
    conn: &Connection,
    ws: &str,
    parent: &str,
    title: &str,
    i: usize,
    rng: &mut Rng,
) -> String {
    let id = new_id();
    let now = 1_700_000_000_000i64 + i as i64;
    conn.prepare_cached("INSERT INTO boards (id, workspace_id, parent_board_id, title, color_token, symbol, revision, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL, 1, ?6, ?6)").unwrap().execute(params![id, ws, parent, title, "default", now]).unwrap();
    conn.prepare_cached("INSERT INTO board_view_states (board_id, viewport_x, viewport_y, zoom, revision, updated_at) VALUES (?1, 0, 0, 1, 1, ?2)").unwrap().execute(params![id, now]).unwrap();
    let pid = new_id();
    add_card_row(conn, &pid, parent, "board_portal", i, rng);
    conn.prepare_cached(
        "INSERT INTO board_portal_cards (card_id, target_board_id) VALUES (?1, ?2)",
    )
    .unwrap()
    .execute(params![pid, id])
    .unwrap();
    id
}

/// Child boards under Home (random parents) plus n_cards cards spread over all boards.
fn seed_tree(
    conn: &Connection,
    n_boards: usize,
    n_cards: usize,
    doc_words: usize,
    rng: &mut Rng,
) -> Vec<String> {
    let (ws, home) = ws_and_home(conn);
    conn.execute_batch("BEGIN IMMEDIATE").unwrap();
    let assets = add_assets(conn, (n_cards / 25).max(4));
    let mut boards = vec![home];
    for i in 0..n_boards {
        let parent = boards[rng.below(boards.len())].clone();
        let id = add_child_board(conn, &ws, &parent, &format!("Board {i}"), i, rng);
        boards.push(id);
    }
    add_cards(conn, &boards, n_cards, doc_words, &assets, rng);
    conn.execute_batch("COMMIT").unwrap();
    boards
}

/// One board holding exactly n_cards cards (7% are portals to small child boards).
fn seed_big_board(
    conn: &Connection,
    ws: &str,
    parent: &str,
    title: &str,
    n_cards: usize,
    assets: &[String],
    rng: &mut Rng,
) -> String {
    let id = add_child_board(conn, ws, parent, title, 0, rng);
    let portals = n_cards * 7 / 100;
    for p in 0..portals {
        let child = add_child_board(conn, ws, &id, &format!("Sub {p}"), p, rng);
        for k in 0..6 {
            add_one_card(conn, &child, k, 25, assets, rng);
        }
    }
    add_cards(
        conn,
        std::slice::from_ref(&id),
        n_cards - portals,
        25,
        assets,
        rng,
    );
    id
}

// ---- mutation builders ----------------------------------------------------------

fn home_of(ws: &Workspace) -> String {
    ws.read_blocking(|c| Ok(c.query_row("SELECT root_board_id FROM workspaces", [], |r| r.get(0))?))
        .unwrap()
}

fn frame_n(n: usize) -> Frame {
    Frame {
        x: (n % 40) as f64 * 250.0,
        y: (n / 40) as f64 * 150.0,
        width: 240.0,
        height: 120.0,
    }
}

fn create_note(board: &str, id: &str, n: usize, doc_words: usize, rng: &mut Rng) -> Mutation {
    Mutation::CreateNote(CreateNoteInput {
        id: id.to_string(),
        board_id: board.to_string(),
        frame: frame_n(n),
        z_index: n as i64,
        document_json: doc(&words(rng, doc_words)),
    })
}

fn update_note(id: &str, rev: i64, doc_words: usize, rng: &mut Rng) -> Mutation {
    Mutation::UpdateNote(UpdateNoteInput {
        id: id.to_string(),
        expected_revision: rev,
        document_json: doc(&words(rng, doc_words)),
        acknowledge_corrupt: false,
    })
}

fn move_card(id: &str, rev: i64, n: usize) -> Mutation {
    Mutation::MoveCard(UpdateCardFrameInput {
        id: id.to_string(),
        expected_revision: rev,
        frame: frame_n(n + 7),
    })
}

#[test]
#[ignore]
fn f_writer_throughput() {
    let tmp = Tmp::new("writer");
    let ws = Workspace::open(WorkspacePaths::new(tmp.path())).unwrap();
    let home = home_of(&ws);
    let mut rng = Rng(12345);
    let mut notes: Vec<(String, i64)> = Vec::new();
    let mut lat = Vec::new();
    for n in 0..1000 {
        let id = new_id();
        let m = create_note(&home, &id, n, 25, &mut rng);
        let t = Instant::now();
        let r = ws.apply_blocking(m).unwrap().into_card_receipt().unwrap();
        lat.push(t.elapsed());
        notes.push((id, r.revision));
    }
    stats("F1 create_note x1000 (sequential, apply_blocking)", &lat);
    let mut lat = Vec::new();
    for note in notes.iter_mut() {
        let (id, rev) = note.clone();
        let m = update_note(&id, rev, 25, &mut rng);
        let t = Instant::now();
        let r = ws.apply_blocking(m).unwrap().into_text_receipt().unwrap();
        lat.push(t.elapsed());
        note.1 = r.revision;
    }
    stats("F2 update_note (autosave) x1000", &lat);
    let mut lat = Vec::new();
    for (n, note) in notes.iter_mut().enumerate() {
        let (id, rev) = note.clone();
        let m = move_card(&id, rev, n);
        let t = Instant::now();
        let r = ws.apply_blocking(m).unwrap().into_card_receipt().unwrap();
        lat.push(t.elapsed());
        note.1 = r.revision;
    }
    stats("F3 move_card x1000", &lat);
    let journal_rows: i64 = ws
        .read_blocking(|c| Ok(c.query_row("SELECT COUNT(*) FROM changes", [], |r| r.get(0))?))
        .unwrap();
    println!("F journal rows after 3000 mutations: {journal_rows}");
    // Concurrent callers: 4 threads x 250 updates on disjoint notes.
    let t = Instant::now();
    let per_thread: Vec<Vec<Duration>> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..4)
            .map(|k| {
                let ws = ws.clone();
                let mine: Vec<(String, i64)> = notes[k * 250..(k + 1) * 250].to_vec();
                s.spawn(move || {
                    let mut rng = Rng(777 + k as u64);
                    let mut lat = Vec::new();
                    let mut mine = mine;
                    for (id, rev) in mine.iter_mut() {
                        let m = update_note(id, *rev, 25, &mut rng);
                        let t = Instant::now();
                        let r = ws.apply_blocking(m).unwrap().into_text_receipt().unwrap();
                        lat.push(t.elapsed());
                        *rev = r.revision;
                    }
                    lat
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let wall = t.elapsed();
    let all: Vec<Duration> = per_thread.into_iter().flatten().collect();
    stats(
        "F4 update_note 4 threads x 250 (latency incl. queue wait)",
        &all,
    );
    println!(
        "F4 wall {:.2}s => {:.0} mutations/s",
        wall.as_secs_f64(),
        1000.0 / wall.as_secs_f64()
    );
}

#[test]
#[ignore]
fn f2_sync_modes() {
    let tmp = Tmp::new("syncmodes");
    let paths = WorkspacePaths::new(tmp.path());
    let mut conn = db::open_and_bootstrap(&paths.db_path()).unwrap();
    let home: String = conn
        .query_row("SELECT root_board_id FROM workspaces", [], |r| r.get(0))
        .unwrap();
    let mut rng = Rng(99);
    let mut notes: Vec<(String, i64)> = Vec::new();
    for n in 0..1000 {
        let id = new_id();
        let r = myspace_lib::sync::funnel::apply(
            &mut conn,
            &create_note(&home, &id, n, 25, &mut rng),
            &paths,
        )
        .unwrap()
        .into_card_receipt()
        .unwrap();
        notes.push((id, r.revision));
    }
    for (label, pragma) in [
        ("FULL (app default)", ""),
        ("FULL + fullfsync=ON", "PRAGMA fullfsync=ON;"),
        ("NORMAL", "PRAGMA fullfsync=OFF; PRAGMA synchronous=NORMAL;"),
    ] {
        if !pragma.is_empty() {
            conn.execute_batch(pragma).unwrap();
        }
        let mut lat = Vec::new();
        for note in notes.iter_mut() {
            let (id, rev) = note.clone();
            let m = update_note(&id, rev, 25, &mut rng);
            let t = Instant::now();
            let r = myspace_lib::sync::funnel::apply(&mut conn, &m, &paths)
                .unwrap()
                .into_text_receipt()
                .unwrap();
            lat.push(t.elapsed());
            note.1 = r.revision;
        }
        stats(
            &format!("F5 update_note x1000, synchronous mode = {label}"),
            &lat,
        );
    }
}

fn raw(path: &Path) -> Connection {
    let c = Connection::open(path).unwrap();
    db::apply_pragmas(&c).unwrap();
    c
}

fn file_len(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// The database phases of a backup snapshot, timed one by one on copies in a
/// scratch dir: the online backup (as `db::backup` runs it, and in one step),
/// the WAL-to-DELETE switch of the copy, and each validation pragma.
fn snapshot_db_phases(label: &str, db_path: &Path) {
    let scratch = Tmp::new("phases");
    let src = Connection::open(db_path).unwrap();
    let page_size: i64 = src.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap();
    let pages: i64 = src
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .unwrap();
    let copy = |name: &str, step: i32, pause: Duration| -> (PathBuf, Duration, Duration) {
        let dest = scratch.path().join(name);
        let mut dst = Connection::open(&dest).unwrap();
        let t = Instant::now();
        rusqlite::backup::Backup::new(&src, &mut dst)
            .unwrap()
            .run_to_completion(step, pause, None)
            .unwrap();
        let backup = t.elapsed();
        let t = Instant::now();
        dst.execute_batch("PRAGMA journal_mode = DELETE; PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
        (dest, backup, t.elapsed())
    };
    let (_, prod, prod_mode) = copy("prod.sqlite3", 100, Duration::from_millis(10));
    let (dest, one, one_mode) = copy("one.sqlite3", i32::MAX, Duration::ZERO);
    let snap = Connection::open(&dest).unwrap();
    let timed = |sql: &str| {
        let t = Instant::now();
        let mut st = snap.prepare(sql).unwrap();
        let n = st.query_map([], |_| Ok(())).unwrap().count();
        (t.elapsed(), n)
    };
    let (integrity, _) = timed("PRAGMA integrity_check");
    snap.execute_batch("PRAGMA cache_size = -131072").unwrap();
    let (integrity_cached, _) = timed("PRAGMA integrity_check");
    let (quick, _) = timed("PRAGMA quick_check");
    let (fk, fk_rows) = timed("PRAGMA foreign_key_check");
    println!(
        "{label}: {pages} pages x {page_size} B = {} MiB; online backup as in db::backup (100 pages/step, 10 ms pause) {:.0}ms + journal_mode {:.0}ms; one step {:.0}ms + {:.0}ms; integrity_check {:.0}ms (128 MiB page cache: {:.0}ms); quick_check {:.0}ms; foreign_key_check {:.0}ms ({fk_rows} rows)",
        pages * page_size / 1048576, ms(prod), ms(prod_mode), ms(one), ms(one_mode), ms(integrity), ms(integrity_cached), ms(quick), ms(fk)
    );
}

/// A workspace at `paths` whose journal holds 100 000 changes: 200 boards,
/// then a mix of note creations, edits and moves. Returns the writer
/// latency of every mutation.
fn journal_100k(paths: &WorkspacePaths) -> (Workspace, Vec<Duration>) {
    let ws = Workspace::open(paths.clone()).unwrap();
    let home = home_of(&ws);
    let mut rng = Rng(4242);
    let mut boards = vec![home.clone()];
    for i in 0..200 {
        let b = new_id();
        ws.apply_blocking(Mutation::CreateChildBoard(CreateChildBoardInput {
            parent_board_id: home.clone(),
            board_id: b.clone(),
            portal_card_id: new_id(),
            frame: frame_n(i),
            title: format!("Board {i}"),
        }))
        .unwrap();
        boards.push(b);
    }
    let mut notes: Vec<(String, i64)> = Vec::new();
    let mut lat = Vec::new();
    let mut n = 0usize;
    loop {
        if n.is_multiple_of(2000) {
            let c: i64 = ws
                .read_blocking(|c| {
                    Ok(c.query_row("SELECT COUNT(*) FROM changes", [], |r| r.get(0))?)
                })
                .unwrap();
            if c >= 100_000 {
                break;
            }
        }
        n += 1;
        let r = rng.below(3);
        let t1 = Instant::now();
        if notes.len() < 500 || r == 0 {
            let id = new_id();
            let b = boards[rng.below(boards.len())].clone();
            let rc = ws
                .apply_blocking(create_note(&b, &id, n % 2000, 25, &mut rng))
                .unwrap()
                .into_card_receipt()
                .unwrap();
            notes.push((id, rc.revision));
        } else if r == 1 {
            let i = rng.below(notes.len());
            let (id, rev) = notes[i].clone();
            let rc = ws
                .apply_blocking(update_note(&id, rev, 25, &mut rng))
                .unwrap()
                .into_text_receipt()
                .unwrap();
            notes[i].1 = rc.revision;
        } else {
            let i = rng.below(notes.len());
            let (id, rev) = notes[i].clone();
            let rc = ws
                .apply_blocking(move_card(&id, rev, n % 2000))
                .unwrap()
                .into_card_receipt()
                .unwrap();
            notes[i].1 = rc.revision;
        }
        lat.push(t1.elapsed());
    }
    (ws, lat)
}

#[test]
#[ignore]
fn d_journal_100k() {
    let tmp = Tmp::new("journal");
    let a_paths = WorkspacePaths::new(tmp.path().join("a"));
    let t_gen = Instant::now();
    let (ws, lat) = journal_100k(&a_paths);
    println!(
        "D generated via {} mutations in {:.1}s",
        lat.len(),
        t_gen.elapsed().as_secs_f64()
    );
    stats("D writer latency, first 10k mutations", &lat[..10000]);
    stats(
        "D writer latency, last 10k mutations (journal ~100k)",
        &lat[lat.len() - 10000..],
    );
    let rc = db::open_readonly_checked(&a_paths.db_path()).unwrap();
    rc.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").ok();
    let total: i64 = rc
        .query_row("SELECT COUNT(*) FROM changes", [], |r| r.get(0))
        .unwrap();
    let dev: String = rc
        .query_row("SELECT origin_device_id FROM changes LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    let max_hlc: String = rc
        .query_row("SELECT MAX(hlc) FROM changes", [], |r| r.get(0))
        .unwrap();
    let avg_payload: f64 = rc
        .query_row("SELECT AVG(length(payload_json)) FROM changes", [], |r| {
            r.get(0)
        })
        .unwrap();
    let cards: i64 = rc
        .query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0))
        .unwrap();
    println!(
        "D changes={total} cards={cards} avg payload_json={avg_payload:.0} B; db file={} MiB",
        file_len(&a_paths.db_path()) / 1048576
    );
    match rc.prepare("SELECT name, SUM(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC LIMIT 8") {
        Ok(mut st) => {
            let rows = st
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .unwrap();
            for r in rows {
                let (name, bytes) = r.unwrap();
                println!(
                    "D dbstat {name}: {} KiB ({:.0} B/change)",
                    bytes / 1024,
                    bytes as f64 / total as f64
                );
            }
        }
        Err(e) => println!("D dbstat unavailable: {e}"),
    }
    // The statements `journal::changes_since` runs: origins, then keys above
    // a cursor.
    for sql in [
        "SELECT (SELECT MIN(origin_device_id) FROM changes WHERE origin_device_id > ?1), ?2",
        "SELECT hlc, seq FROM changes WHERE origin_device_id = ?1 AND hlc > ?2 ORDER BY hlc LIMIT 501",
    ] {
        let mut st = rc.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let plan: Vec<String> = st
            .query_map(params![dev, max_hlc], |r| r.get::<_, String>(3))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        println!("D changes_since plan: {plan:?}");
    }
    let mut idle = Vec::new();
    let mut at_end = std::collections::BTreeMap::new();
    at_end.insert(dev.clone(), max_hlc.clone());
    for _ in 0..20 {
        let t = Instant::now();
        let p = journal::changes_since(&rc, &at_end, 500).unwrap();
        idle.push(t.elapsed());
        assert!(p.rows.is_empty());
    }
    stats(
        "D idle poll changes_since (cursor at end, 0 rows) at 100k",
        &idle,
    );
    let mut cursors = std::collections::BTreeMap::new();
    let mut pages = Vec::new();
    loop {
        let t = Instant::now();
        let p = journal::changes_since(&rc, &cursors, 500).unwrap();
        pages.push(t.elapsed());
        match p.next {
            Some(nx) => cursors = nx,
            None => break,
        }
    }
    let k = pages.len();
    println!(
        "D export walk: {k} pages of 500; page1={:.2}ms page{}={:.2}ms last={:.2}ms; sum={:.2}s",
        ms(pages[0]),
        k / 2,
        ms(pages[k / 2]),
        ms(pages[k - 1]),
        pages.iter().sum::<Duration>().as_secs_f64()
    );
    let b_paths = WorkspacePaths::new(tmp.path().join("b"));
    let b = Workspace::open(b_paths.clone()).unwrap();
    let mut cursors = b.read_blocking(journal::our_cursors).unwrap();
    let mut apply_t = Vec::new();
    let mut export_t = Duration::ZERO;
    let t_all = Instant::now();
    loop {
        let t = Instant::now();
        let page = journal::changes_since(&rc, &cursors, 500).unwrap();
        export_t += t.elapsed();
        if !page.rows.is_empty() {
            let t = Instant::now();
            b.apply_blocking(Mutation::ApplySyncChanges(page.rows))
                .unwrap()
                .into_sync_report()
                .unwrap();
            apply_t.push(t.elapsed());
        }
        match page.next {
            Some(nx) => cursors = nx,
            None => break,
        }
    }
    let wall = t_all.elapsed();
    let m = apply_t.len();
    let mean = |s: &[Duration]| ms(s.iter().sum::<Duration>()) / s.len() as f64;
    println!("D replay of {total} rows into fresh DB: wall={:.1}s (export {:.1}s, apply {:.1}s) => {:.0} rows/s; apply per 500-row page: first10 mean={:.1}ms mid10={:.1}ms last10 mean={:.1}ms", wall.as_secs_f64(), export_t.as_secs_f64(), apply_t.iter().sum::<Duration>().as_secs_f64(), total as f64 / wall.as_secs_f64(), mean(&apply_t[..10]), mean(&apply_t[m / 2..m / 2 + 10]), mean(&apply_t[m - 10..]));
    let b_cards: i64 = b
        .read_blocking(|c| Ok(c.query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0))?))
        .unwrap();
    let b_changes: i64 = b
        .read_blocking(|c| Ok(c.query_row("SELECT COUNT(*) FROM changes", [], |r| r.get(0))?))
        .unwrap();
    println!(
        "D replica: cards={b_cards} (source {cards}) changes={b_changes} db file={} MiB",
        file_len(&b_paths.db_path()) / 1048576
    );
    drop(ws);
    let db_mib = file_len(&a_paths.db_path()) / 1048576;
    for k in 0..3 {
        let t = Instant::now();
        backup::snapshot_before_destructive_operation(
            &a_paths.db_path(),
            &a_paths.assets_dir(),
            &a_paths.backups_dir(),
        )
        .unwrap();
        println!(
            "D backup snapshot #{k} of the {db_mib} MiB 100k-journal DB (no assets): {:.0}ms",
            ms(t.elapsed())
        );
    }
    snapshot_db_phases("D snapshot phases", &a_paths.db_path());
}

/// Checkpoints the WAL into the file and returns (file bytes, pages, free
/// pages) of the database at `path`.
fn file_stats(path: &Path) -> (u64, i64, i64) {
    let c = raw(path);
    c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    let pages: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    let free: i64 = c
        .query_row("PRAGMA freelist_count", [], |r| r.get(0))
        .unwrap();
    (file_len(path), pages, free)
}

/// Replays everything `source` serves into a fresh workspace at `dir`, in
/// 500-row pages as the LAN loop does. Returns the wall time and the
/// replica's (cards, sum of note text lengths) as a cheap equality check.
fn replay_fresh(source: &Path, dir: PathBuf) -> (Duration, (i64, i64)) {
    let rc = db::open_readonly_checked(source).unwrap();
    let b = Workspace::open(WorkspacePaths::new(dir)).unwrap();
    let mut cursors = b.read_blocking(journal::our_cursors).unwrap();
    let t = Instant::now();
    loop {
        let page = journal::changes_since(&rc, &cursors, 500).unwrap();
        if !page.rows.is_empty() {
            b.apply_blocking(Mutation::ApplySyncChanges(page.rows))
                .unwrap();
        }
        match page.next {
            Some(nx) => cursors = nx,
            None => break,
        }
    }
    let wall = t.elapsed();
    let check = b
        .read_blocking(|c| {
            Ok(c.query_row(
                "SELECT (SELECT COUNT(*) FROM cards), (SELECT SUM(length(plain_text)) FROM note_cards)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    (wall, check)
}

/// ADR-0011 amendment 2026-09-30: the 100 000-change journal before and
/// after compaction (rows, file size, compaction time, writer stall per
/// chunk, VACUUM) and a full replay into a fresh database from each.
#[test]
#[ignore]
fn k_compaction_100k() {
    let tmp = Tmp::new("compaction");
    let a_paths = WorkspacePaths::new(tmp.path().join("a"));
    let (ws, _) = journal_100k(&a_paths);
    let count = |ws: &Workspace| -> i64 {
        ws.read_blocking(|c| Ok(c.query_row("SELECT COUNT(*) FROM changes", [], |r| r.get(0))?))
            .unwrap()
    };
    let mib = |b: u64| b as f64 / 1048576.0;
    let rows_before = count(&ws);
    let (bytes_before, pages, free) = file_stats(&a_paths.db_path());
    println!(
        "K before: changes={rows_before} db file={:.1} MiB ({pages} pages, {free} free)",
        mib(bytes_before)
    );
    let (replay_before, check_before) = replay_fresh(&a_paths.db_path(), tmp.path().join("b1"));
    println!(
        "K full replay into a fresh DB from the full journal: {:.1}s",
        replay_before.as_secs_f64()
    );

    let mut chunks = Vec::new();
    let mut deleted = 0;
    let t = Instant::now();
    loop {
        let t_chunk = Instant::now();
        let chunk = ws
            .apply_blocking(Mutation::CompactJournal)
            .unwrap()
            .into_compaction()
            .unwrap();
        chunks.push(t_chunk.elapsed());
        deleted += chunk.deleted;
        if chunk.done {
            break;
        }
    }
    let total = t.elapsed();
    let rest = &chunks[1..];
    println!(
        "K compaction: {:.2}s in {} chunks, {deleted} rows deleted; first chunk (with the pre-compaction backup) {:.0}ms; other chunks max {:.0}ms mean {:.0}ms",
        total.as_secs_f64(),
        chunks.len(),
        ms(chunks[0]),
        rest.iter().map(|d| ms(*d)).fold(0.0, f64::max),
        if rest.is_empty() { 0.0 } else { ms(rest.iter().sum::<Duration>()) / rest.len() as f64 }
    );
    let t = Instant::now();
    let again = compact::run_blocking(&ws).unwrap();
    println!(
        "K second run: {} deleted, {} entities, {:.0}ms",
        again.deleted,
        again.entities,
        ms(t.elapsed())
    );

    let rows_after = count(&ws);
    let (bytes_after, pages, free) = file_stats(&a_paths.db_path());
    println!(
        "K after: changes={rows_after} db file={:.1} MiB ({pages} pages, {free} free = {:.0}%)",
        mib(bytes_after),
        100.0 * free as f64 / pages as f64
    );
    let t = Instant::now();
    let ran = ws
        .apply_blocking(Mutation::VacuumIfDue)
        .unwrap()
        .into_count()
        .unwrap();
    let vacuum = t.elapsed();
    let (bytes_vacuumed, _, _) = file_stats(&a_paths.db_path());
    println!(
        "K VACUUM (due={}): {:.2}s, db file {:.1} MiB",
        ran == 1,
        vacuum.as_secs_f64(),
        mib(bytes_vacuumed)
    );

    let (replay_after, check_after) = replay_fresh(&a_paths.db_path(), tmp.path().join("b2"));
    println!(
        "K full replay into a fresh DB from the compacted journal: {:.1}s",
        replay_after.as_secs_f64()
    );
    assert_eq!(check_after, check_before, "same cards and texts");
}

/// Where replay time goes: the same exported journal replayed into fresh
/// databases under settings that each remove one suspect (sub-journal on
/// disk, fsync, the search-index triggers), plus the WAL written per page.
#[test]
#[ignore]
fn r_replay_attribution() {
    let tmp = Tmp::new("replay");
    let (ws, _) = journal_100k(&WorkspacePaths::new(tmp.path().join("a")));
    let pages: Vec<Vec<myspace_lib::sync::ChangeRow>> = ws
        .read_blocking(|c| {
            let mut pages = Vec::new();
            let mut cursors = std::collections::BTreeMap::new();
            loop {
                let page = journal::changes_since(c, &cursors, 500)?;
                pages.push(page.rows);
                match page.next {
                    Some(next) => cursors = next,
                    None => return Ok(pages),
                }
            }
        })
        .unwrap();
    let drop_search = "SELECT group_concat('DROP TRIGGER ' || name, '; ') FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'search_%'";
    for (k, (label, setup)) in [
        ("as is", ""),
        ("temp_store = MEMORY", "PRAGMA temp_store = MEMORY;"),
        ("synchronous = OFF", "PRAGMA synchronous = OFF;"),
        ("search triggers dropped", drop_search),
        (
            "no autocheckpoint (WAL bytes)",
            "PRAGMA wal_autocheckpoint = 0;",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        replay_raw(label, &tmp.path().join(format!("raw-{k}")), &pages, setup);
    }
}

/// Replays exported pages into a fresh database through the writer funnel on
/// a plain connection, after `setup` (a pragma, or a query that returns
/// statements to run).
fn replay_raw(label: &str, dir: &Path, pages: &[Vec<myspace_lib::sync::ChangeRow>], setup: &str) {
    let paths = WorkspacePaths::new(dir);
    std::fs::create_dir_all(dir).unwrap();
    let mut conn = db::open_and_bootstrap(&paths.db_path()).unwrap();
    if setup.starts_with("SELECT") {
        let statements: String = conn.query_row(setup, [], |r| r.get(0)).unwrap();
        conn.execute_batch(&statements).unwrap();
    } else {
        conn.execute_batch(setup).unwrap();
    }
    let wal = PathBuf::from(format!("{}-wal", paths.db_path().display()));
    let measure_wal = setup.contains("wal_autocheckpoint");
    let mut apply_t = Vec::new();
    let mut wal_bytes = Vec::new();
    for rows in pages {
        let t = Instant::now();
        myspace_lib::sync::funnel::apply(
            &mut conn,
            &Mutation::ApplySyncChanges(rows.clone()),
            &paths,
        )
        .unwrap()
        .into_sync_report()
        .unwrap();
        apply_t.push(t.elapsed());
        if measure_wal {
            wal_bytes.push(file_len(&wal));
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
                .unwrap();
        }
    }
    let m = apply_t.len();
    let mean = |s: &[Duration]| ms(s.iter().sum::<Duration>()) / s.len() as f64;
    println!(
        "R raw replay, {label}: apply {:.1}s; per page first10 {:.1}ms mid10 {:.1}ms last10 {:.1}ms",
        apply_t.iter().sum::<Duration>().as_secs_f64(),
        mean(&apply_t[..10]),
        mean(&apply_t[m / 2..m / 2 + 10]),
        mean(&apply_t[m - 10..])
    );
    let curve: Vec<String> = apply_t
        .chunks(20)
        .map(|c| format!("{:.0}", mean(c)))
        .collect();
    println!(
        "R {label}: ms per page, 20-page slices: {}",
        curve.join(" ")
    );
    if !wal_bytes.is_empty() {
        let curve: Vec<String> = wal_bytes
            .chunks(20)
            .map(|c| format!("{}", c.iter().sum::<u64>() / c.len() as u64 / 1024))
            .collect();
        println!(
            "R {label}: WAL KiB per page, 20-page slices: {}",
            curve.join(" ")
        );
    }
}

fn open_board(rc: &Connection, label: &str, id: &str) {
    let t = Instant::now();
    let snap = repo::load_board_snapshot(rc, id).unwrap();
    let first = t.elapsed();
    let mut v = Vec::new();
    for _ in 0..7 {
        let t = Instant::now();
        let _ = repo::load_board_snapshot(rc, id).unwrap();
        v.push(t.elapsed());
    }
    let t = Instant::now();
    let json = serde_json::to_vec(&snap).unwrap();
    let ser = t.elapsed();
    v.sort();
    println!("C {label}: cards={} unsorted={} first={:.1}ms warm p50={:.1}ms max={:.1}ms; JSON {} KiB serialize {:.1}ms", snap.cards.len(), snap.unsorted_cards.len(), ms(first), ms(v[3]), ms(v[6]), json.len() / 1024, ms(ser));
}

#[test]
#[ignore]
fn c_board_open() {
    let tmp = Tmp::new("board");
    let path = tmp.path().join("workspace.sqlite3");
    drop(db::open_and_bootstrap(&path).unwrap());
    let conn = raw(&path);
    let mut rng = Rng(5);
    let (ws, home) = ws_and_home(&conn);
    conn.execute_batch("BEGIN IMMEDIATE").unwrap();
    let assets = add_assets(&conn, 300);
    let b1 = seed_big_board(&conn, &ws, &home, "big1k", 1000, &assets, &mut rng);
    let b5 = seed_big_board(&conn, &ws, &home, "big5k", 5000, &assets, &mut rng);
    conn.execute_batch("COMMIT").unwrap();
    let rc = db::open_readonly_checked(&path).unwrap();
    open_board(&rc, "1000-card board, small DB", &b1);
    open_board(&rc, "5000-card board, small DB", &b5);
    let boards = seed_tree(&conn, 3000, 50000, 25, &mut rng);
    open_board(&rc, "1000-card board, DB now +50k cards elsewhere", &b1);
    open_board(&rc, "5000-card board, DB now +50k cards elsewhere", &b5);
    open_board(&rc, "typical ~17-card board in 50k DB", &boards[1500]);
    for q in ["nebu", "работа", "a", "ab", "ъщ", "zzzqqq"] {
        let t = Instant::now();
        let r = repo::search_workspace(&rc, q).unwrap();
        println!(
            "C search {q:?} over ~50k mixed cards: {:.1}ms ({} results)",
            ms(t.elapsed()),
            r.len()
        );
    }
}

#[test]
#[ignore]
fn e_startup_50k() {
    let tmp = Tmp::new("startup");
    let path = tmp.path().join("workspace.sqlite3");
    drop(db::open_and_bootstrap(&path).unwrap());
    {
        let conn = raw(&path);
        let mut rng = Rng(9);
        seed_tree(&conn, 3000, 50000, 25, &mut rng);
        conn.execute(
            "DELETE FROM local_meta WHERE key = ?1",
            ["journal_snapshot_done"],
        )
        .unwrap();
        conn.execute_batch("DELETE FROM changes; DELETE FROM entity_clocks; DELETE FROM sync_cursors; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    }
    println!("E db before backfill: {} MiB", file_len(&path) / 1048576);
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let peak = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let (s2, p2) = (stop.clone(), peak.clone());
    let pid = std::process::id().to_string();
    let sampler = std::thread::spawn(move || {
        while !s2.load(std::sync::atomic::Ordering::Relaxed) {
            if let Ok(o) = std::process::Command::new("ps")
                .args(["-o", "rss=", "-p", &pid])
                .output()
            {
                if let Ok(kb) = String::from_utf8_lossy(&o.stdout).trim().parse::<u64>() {
                    p2.fetch_max(kb, std::sync::atomic::Ordering::Relaxed);
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    });
    std::thread::sleep(Duration::from_millis(200));
    let base_kb = peak.load(std::sync::atomic::Ordering::Relaxed);
    let t = Instant::now();
    let conn = db::open_and_bootstrap(&path).unwrap();
    let first = t.elapsed();
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    sampler.join().unwrap();
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM changes", [], |r| r.get(0))
        .unwrap();
    let bytes: i64 = conn
        .query_row("SELECT SUM(length(payload_json)) FROM changes", [], |r| {
            r.get(0)
        })
        .unwrap();
    println!("E first start incl. one-time journal backfill (50k cards, 3k boards): {:.2}s; wrote {rows} change rows, payload {} MiB; RSS baseline {} MiB, sampled peak {} MiB; db now {} MiB", first.as_secs_f64(), bytes / 1048576, base_kb / 1024, peak.load(std::sync::atomic::Ordering::Relaxed) / 1024, file_len(&path) / 1048576);
    drop(conn);
    let t = Instant::now();
    let ws = Workspace::open(WorkspacePaths::new(tmp.path())).unwrap();
    println!(
        "E second (normal) start, Workspace::open: {:.1}ms",
        ms(t.elapsed())
    );
    drop(ws);
    let t = Instant::now();
    let rep = backup::snapshot_before_destructive_operation(
        &path,
        &tmp.path().join("assets"),
        &tmp.path().join("backups"),
    )
    .unwrap();
    println!(
        "E backup snapshot of this DB ({} asset rows, files absent): {:.2}s",
        rep.missing_assets.len(),
        t.elapsed().as_secs_f64()
    );
}

fn backup_case(label: &str, n_files: usize, size: usize) {
    let tmp = Tmp::new("backup");
    let root = tmp.path().to_path_buf();
    let db_path = root.join("workspace.sqlite3");
    let assets = root.join("assets");
    std::fs::create_dir_all(&assets).unwrap();
    let conn = db::open_and_bootstrap(&db_path).unwrap();
    let mut rng = Rng(1);
    let mut buf = vec![0u8; size];
    for chunk in buf.chunks_mut(8) {
        let v = rng.next().to_le_bytes();
        let l = chunk.len();
        chunk.copy_from_slice(&v[..l]);
    }
    conn.execute_batch("BEGIN").unwrap();
    for i in 0..n_files {
        buf[..8].copy_from_slice(&(i as u64).to_le_bytes());
        let name = format!("{i:05}.bin");
        std::fs::write(assets.join(&name), &buf).unwrap();
        conn.execute("INSERT INTO assets (id, file_path, mime_type, file_name, size_bytes, created_at, sha256) VALUES (?1, ?2, ?3, ?2, ?4, 0, ?5)", params![new_id(), name, "application/octet-stream", size as i64, format!("{i:064x}")]).unwrap();
    }
    conn.execute_batch("COMMIT").unwrap();
    let mut times = Vec::new();
    for k in 0..12 {
        let t = Instant::now();
        let rep =
            backup::snapshot_before_destructive_operation(&db_path, &assets, &root.join("backups"))
                .unwrap();
        times.push(t.elapsed());
        if k == 0 {
            println!(
                "A {label}: first snapshot {:.0}ms, assets={} linked={}",
                ms(times[0]),
                rep.asset_count,
                rep.linked_asset_count
            );
        }
    }
    println!(
        "A {label}: snapshots 2..11 mean {:.0}ms; 12th (retention prune of 10 kept) {:.0}ms",
        ms(times[1..11].iter().sum::<Duration>()) / 10.0,
        ms(times[11])
    );
    let backups = root.join("backups");
    let t = Instant::now();
    backup::prune_old_backups(&backups);
    let prune = t.elapsed();
    let scratch = Tmp::new("links");
    let names: Vec<String> = (0..n_files).map(|i| format!("{i:05}.bin")).collect();
    let t = Instant::now();
    for name in &names {
        let dst = scratch.path().join("assets").join(name);
        std::fs::create_dir_all(dst.parent().unwrap()).unwrap();
        std::fs::hard_link(assets.join(name), dst).unwrap();
    }
    let link = t.elapsed();
    let t = Instant::now();
    for name in &names {
        std::fs::create_dir_all(scratch.path().join("assets").join(name).parent().unwrap())
            .unwrap();
    }
    let mkdir = t.elapsed();
    let linked_par = |threads: usize| {
        let dir = scratch.path().join(format!("par-{threads}"));
        std::fs::create_dir_all(&dir).unwrap();
        let t = Instant::now();
        std::thread::scope(|s| {
            for chunk in names.chunks(names.len().div_ceil(threads)) {
                let (dir, assets) = (&dir, &assets);
                s.spawn(move || {
                    for name in chunk {
                        std::fs::hard_link(assets.join(name), dir.join(name)).unwrap();
                    }
                });
            }
        });
        t.elapsed()
    };
    let (par1, par4, par8) = (linked_par(1), linked_par(4), linked_par(8));
    println!("A {label}: link split: create_dir_all alone {:.0}ms; hard_link alone 1 thread {:.0}ms, 4 threads {:.0}ms, 8 threads {:.0}ms", ms(mkdir), ms(par1), ms(par4), ms(par8));
    snapshot_db_phases(&format!("A {label} DB phases"), &db_path);
    println!("A {label}: phases: prune of 10 kept snapshots {:.0}ms; create_dir_all + hard_link per asset {:.0}ms", ms(prune), ms(link));
    let t = Instant::now();
    let missing = journal::missing_blobs(&conn, &assets).unwrap();
    println!(
        "A {label}: journal::missing_blobs (runs every sync pull) {:.1}ms, missing={}",
        ms(t.elapsed()),
        missing.len()
    );
}

#[test]
#[ignore]
fn a_backup_2gb() {
    backup_case("2048 x 1 MiB = 2 GiB", 2048, 1 << 20);
}

#[test]
#[ignore]
fn a_backup_20k_files() {
    backup_case("20000 x 4 KiB (regime C file count)", 20000, 4096);
}
