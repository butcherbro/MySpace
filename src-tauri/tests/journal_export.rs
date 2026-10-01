//! `journal::changes_since` serves exactly the rows the original single-query
//! export served (every row from an origin absent from the cursors, or above
//! its cursor, in HLC order), page by page, whatever the cursors hold; and
//! `journal::missing_blobs` reports exactly the hashes whose file is absent.

use std::collections::BTreeMap;

use myspace_lib::db;
use myspace_lib::sync::{journal, ChangeRow};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};

fn hlc(ms: u64, counter: u32, device: &str) -> String {
    format!("{ms:015}-{counter:05}-{device}")
}

fn row(origin: &str, hlc: String, n: usize) -> ChangeRow {
    ChangeRow {
        origin_device_id: origin.to_string(),
        hlc,
        entity_kind: "card".to_string(),
        entity_id: format!("card-{n}"),
        op: "card.update".to_string(),
        payload_json: format!("{{\"n\":{n}}}"),
    }
}

/// Three origins with interleaved clocks, a burst of one origin inside one
/// millisecond, and a late row from an origin whose clock runs behind.
fn journal() -> Connection {
    let conn = db::open_in_memory().unwrap();
    let mut n = 0;
    let mut add = |origin: &str, ms: u64, counter: u32| {
        n += 1;
        assert!(
            journal::insert_change(&conn, &row(origin, hlc(ms, counter, origin), n), 0).unwrap()
        );
    };
    for ms in 1..=40u64 {
        add("dev-a", ms * 10, 0);
        if ms % 3 == 0 {
            add("dev-b", ms * 10 + 5, 0);
        }
        if ms % 7 == 0 {
            for counter in 0..4 {
                add("dev-c", ms * 10, counter);
            }
        }
    }
    add("dev-b", 3, 0);
    conn
}

/// The export as it was before the per-origin seeks: one query with an
/// `origin NOT IN (...) OR (origin = ? AND hlc > ?) ...` filter.
fn reference(
    conn: &Connection,
    cursors: &BTreeMap<String, String>,
    limit: usize,
) -> journal::ChangePage {
    let mut clauses = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();
    if cursors.is_empty() {
        clauses.push("1".to_string());
    } else {
        let known = vec!["?"; cursors.len()].join(", ");
        clauses.push(format!("origin_device_id NOT IN ({known})"));
        values.extend(cursors.keys().map(|k| SqlValue::Text(k.clone())));
        for (origin, hlc) in cursors {
            clauses.push("(origin_device_id = ? AND hlc > ?)".to_string());
            values.push(SqlValue::Text(origin.clone()));
            values.push(SqlValue::Text(hlc.clone()));
        }
    }
    values.push(SqlValue::Integer(limit as i64 + 1));
    let sql = format!(
        "SELECT origin_device_id, hlc, entity_kind, entity_id, op, payload_json
         FROM changes WHERE {} ORDER BY hlc, seq LIMIT ?",
        clauses.join(" OR ")
    );
    let mut stmt = conn.prepare(&sql).unwrap();
    let mut rows: Vec<ChangeRow> = stmt
        .query_map(params_from_iter(values.iter()), |r| {
            Ok(ChangeRow {
                origin_device_id: r.get(0)?,
                hlc: r.get(1)?,
                entity_kind: r.get(2)?,
                entity_id: r.get(3)?,
                op: r.get(4)?,
                payload_json: r.get(5)?,
            })
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let next = if rows.len() > limit {
        rows.truncate(limit);
        let mut next = cursors.clone();
        for row in &rows {
            let entry = next.entry(row.origin_device_id.clone()).or_default();
            if row.hlc > *entry {
                *entry = row.hlc.clone();
            }
        }
        Some(next)
    } else {
        None
    };
    journal::ChangePage { rows, next }
}

/// Walks the whole export from `start` with both implementations, comparing
/// every page; returns how many rows the walk served.
fn walk_and_compare(conn: &Connection, start: BTreeMap<String, String>, limit: usize) -> usize {
    let mut cursors = start;
    let mut served = 0;
    loop {
        let page = journal::changes_since(conn, &cursors, limit).unwrap();
        assert_eq!(
            page,
            reference(conn, &cursors, limit),
            "cursors {cursors:?} limit {limit}"
        );
        served += page.rows.len();
        match page.next {
            Some(next) => cursors = next,
            None => return served,
        }
    }
}

fn cursors(entries: &[(&str, String)]) -> BTreeMap<String, String> {
    entries
        .iter()
        .map(|(origin, hlc)| (origin.to_string(), hlc.clone()))
        .collect()
}

#[test]
fn changes_since_serves_the_same_pages_as_the_single_query_export() {
    let conn = journal();
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM changes", [], |r| r.get(0))
        .unwrap();
    let starts = [
        // A fresh device: everything.
        BTreeMap::new(),
        // Knows part of dev-a only: dev-b and dev-c are unknown origins.
        cursors(&[("dev-a", hlc(150, 0, "dev-a"))]),
        // A cursor between dev-c's same-millisecond rows.
        cursors(&[
            ("dev-a", hlc(70, 0, "dev-a")),
            ("dev-c", hlc(70, 1, "dev-c")),
        ]),
        // An origin this journal never saw, next to real ones.
        cursors(&[
            ("dev-z", hlc(999, 0, "dev-z")),
            ("dev-b", hlc(3, 0, "dev-b")),
        ]),
        // A cursor below every row of its origin.
        cursors(&[("dev-b", hlc(1, 0, "dev-b"))]),
    ];
    for start in starts {
        for limit in [1, 2, 7, 500] {
            walk_and_compare(&conn, start.clone(), limit);
        }
    }
    assert_eq!(walk_and_compare(&conn, BTreeMap::new(), 3) as i64, total);
}

#[test]
fn an_idle_poll_at_the_end_of_every_origin_serves_nothing() {
    let conn = journal();
    let held: BTreeMap<String, String> = {
        let mut stmt = conn
            .prepare("SELECT origin_device_id, MAX(hlc) FROM changes GROUP BY origin_device_id")
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        rows
    };
    let page = journal::changes_since(&conn, &held, 500).unwrap();
    assert_eq!(
        page,
        journal::ChangePage {
            rows: Vec::new(),
            next: None
        }
    );
    assert_eq!(page, reference(&conn, &held, 500));
}

#[test]
fn missing_blobs_lists_exactly_the_hashes_without_a_file() {
    let dir = std::env::temp_dir().join(format!("myspace-journal-{}", uuid::Uuid::now_v7()));
    let assets = dir.join("assets");
    std::fs::create_dir_all(&assets).unwrap();
    let conn = db::open_in_memory().unwrap();
    let add = |sha: Option<&str>, file: &str| {
        conn.execute(
            "INSERT INTO assets (id, file_path, mime_type, file_name, size_bytes, created_at, sha256)
             VALUES (?1, ?2, 'image/png', ?2, 1, 0, ?3)",
            rusqlite::params![uuid::Uuid::now_v7().to_string(), file, sha],
        )
        .unwrap();
    };
    let sha = |c: char| c.to_string().repeat(64);
    std::fs::write(assets.join("present.png"), b"x").unwrap();
    add(Some(&sha('a')), "present.png");
    add(Some(&sha('b')), "absent.png");
    // One hash, two files: reported while either is missing.
    std::fs::write(assets.join("copy-1.png"), b"x").unwrap();
    add(Some(&sha('c')), "copy-1.png");
    add(Some(&sha('c')), "copy-2.png");
    // A directory with the asset's name is not its file.
    std::fs::create_dir_all(assets.join("dir.png")).unwrap();
    add(Some(&sha('d')), "dir.png");
    // A name that must never be joined onto the asset dir.
    add(Some(&sha('e')), "../present.png");
    // No hash: cannot be fetched, never listed.
    add(None, "legacy.png");
    #[cfg(unix)]
    {
        // A symlink to a file counts as present, as `is_file` says.
        std::os::unix::fs::symlink(assets.join("present.png"), assets.join("link.png")).unwrap();
        add(Some(&sha('f')), "link.png");
    }

    let missing = journal::missing_blobs(&conn, &assets).unwrap();
    assert_eq!(missing, vec![sha('b'), sha('c'), sha('d'), sha('e')]);
    // No asset dir at all: every hashed asset is missing.
    let none = journal::missing_blobs(&conn, &dir.join("nowhere")).unwrap();
    assert_eq!(none.len(), if cfg!(unix) { 6 } else { 5 });
    std::fs::remove_dir_all(&dir).ok();
}
