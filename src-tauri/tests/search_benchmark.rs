//! Bounded performance check for the FTS5 search index (P1.4): 50 000 notes
//! in a temp-file database, one search well under 100 ms. Prints timings so a
//! regression is visible in `cargo test -- --nocapture`.

use std::time::{Duration, Instant};

use myspace_lib::db::{bootstrap, open};
use myspace_lib::repositories::workspace_repository;

const NOTES: usize = 50_000;
const WORDS: &[&str] = &[
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

fn note_text(i: usize) -> String {
    // Deterministic pseudo-random words, ~25 per note, plus one rare marker
    // word in every 1000th note.
    let mut state = i as u64 * 2_654_435_761 + 1;
    let mut words = Vec::with_capacity(26);
    for _ in 0..25 {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        words.push(WORDS[(state >> 33) as usize % WORDS.len()]);
    }
    let mut text = words.join(" ");
    if i.is_multiple_of(1000) {
        text.push_str(" projection-marker");
    }
    text
}

fn timed(conn: &rusqlite::Connection, query: &str) -> (Duration, usize) {
    // Warm once (statement preparation, page cache), then take the best of 3.
    workspace_repository::search_workspace(conn, query).unwrap();
    let mut best = Duration::MAX;
    let mut count = 0;
    for _ in 0..3 {
        let started = Instant::now();
        let results = workspace_repository::search_workspace(conn, query).unwrap();
        best = best.min(started.elapsed());
        count = results.len();
    }
    (best, count)
}

#[test]
fn search_over_50k_notes_is_fast() {
    let dir = std::env::temp_dir().join(format!("myspace-search-bench-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("workspace.sqlite");

    let mut conn = open(&path).unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home: String = conn
        .query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();

    let started = Instant::now();
    {
        let tx = conn.transaction().unwrap();
        {
            let mut card = tx
                .prepare(
                    "INSERT INTO cards (id, board_id, kind, x, y, width, height, created_at, updated_at)
                     VALUES (?1, ?2, 'note', 0, 0, 200, 80, ?3, ?3)",
                )
                .unwrap();
            let mut note = tx
                .prepare(
                    "INSERT INTO note_cards (card_id, document_json, plain_text) VALUES (?1, '{}', ?2)",
                )
                .unwrap();
            for i in 0..NOTES {
                let id = format!("note-{i:05}");
                card.execute(rusqlite::params![id, home, i as i64]).unwrap();
                note.execute(rusqlite::params![id, note_text(i)]).unwrap();
            }
        }
        tx.commit().unwrap();
    }
    println!(
        "inserted {NOTES} notes (index maintained by triggers) in {:?}",
        started.elapsed()
    );

    let (rare, rare_count) = timed(&conn, "projection");
    println!("rare word  'projection': {rare:?} ({rare_count} results)");
    let (prefix, prefix_count) = timed(&conn, "nebu");
    println!("common prefix 'nebu':    {prefix:?} ({prefix_count} results)");
    let (two, two_count) = timed(&conn, "работа мыс");
    println!("two words 'работа мыс':  {two:?} ({two_count} results)");
    let (miss, miss_count) = timed(&conn, "zzzqqq");
    println!("no match 'zzzqqq':       {miss:?} ({miss_count} results)");
    let (short_miss, short_count) = timed(&conn, "ъщ");
    println!(
        "short no match 'ъщ' (substring fallback scan): {short_miss:?} ({short_count} results)"
    );

    assert_eq!(rare_count, NOTES / 1000);
    assert_eq!(prefix_count, 50);
    assert_eq!(miss_count, 0);
    assert_eq!(short_count, 0);
    assert!(miss < Duration::from_millis(100), "a miss took {miss:?}");
    assert!(
        rare < Duration::from_millis(100),
        "a selective search took {rare:?}"
    );
    assert!(
        prefix < Duration::from_millis(100),
        "a broad prefix search took {prefix:?}"
    );

    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}
