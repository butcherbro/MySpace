//! Journal compaction by dominance (ADR-0011, amendment 2026-09-30).
//!
//! Replay merges registers by last-writer-wins and creates a missing entity
//! from a full image, so a row that another row of the same entity matches or
//! beats on every register is never needed for convergence, by any device.
//! [`compact_chunk`] deletes such rows, per entity:
//!
//! - **R1.** Row R goes when another row R' of the entity has
//!   `clocks[r] >= R.clocks[r]` for every register of R (of two rows with
//!   equal clocks, the older one goes).
//! - **R2.** Never deleted: purge rows; the newest row of each origin (the
//!   HLC high-water mark); for notes, the row that set the current body
//!   clock, and a body-setting row whose `prev.body` came from another
//!   device together with that prev row while the setter is younger than
//!   [`LINEAGE_GRACE_MS`]. `replay::conflict_copy_plan` judges "sequential or
//!   concurrent" from exactly these rows.
//! - **R3.** A purged card with a purge row of its own keeps only its purge
//!   rows (and an R2 origin head), so a purged note's text is not shipped.
//!   Everything else purged keeps all its rows. A card purged here only by a
//!   replay cascade (its board was purged) has no purge row: a device
//!   bootstrapped from this journal must see it created on that board and
//!   purged with it, or a late row of it resurrects it there. And a purged
//!   board is what such a cascade runs on: without its rows that device
//!   never creates it, the cascade finds nothing, and a row that R1 kept
//!   instead (a move written by a device that had not seen the purge) is
//!   dropped there as purged, so the row it superseded is missing too.
//! - **Placement (not in the amendment).** A purge cascade takes what is on
//!   the board at that point of the replay, and a kept row's image may carry
//!   a stale board (card) or parent (board), written by a device that had not
//!   seen a move. So, walking the entity's rows in HLC order and tracking the
//!   place replay's LWW puts in effect (highest `place` clock), every row
//!   that changes the place in effect is kept, including rows older than the
//!   oldest otherwise kept one.
//! - **Creation (not in the amendment).** The oldest row of every board and
//!   asset is kept: created from a later image, it would carry a newer HLC
//!   than the rows that depend on it, and they would replay out of order.
//!
//! Work is bounded: one chunk examines the entities of at most [`CHUNK_ROWS`]
//! rows and runs as one `Mutation::CompactJournal` (one writer transaction);
//! [`run_blocking`] / [`run`] queue chunks until one reports `done`, so user
//! writes interleave. Progress lives in `local_meta`:
//!
//! - [`SEQ_KEY`]: the highest `changes.seq` examined; rows above it are new.
//! - [`AGED_KEY`]: an HLC bound; rows below it whose R2 lineage grace ran out
//!   have been re-examined (their entity may not change again).
//! - [`HEADS_KEY`]: the origin heads R2 protected at the last chunk; a head
//!   that is no longer one gets its entity re-examined.
//! - [`FLOOR_KEY`]: per origin, the highest HLC deleted here. Replay treats a
//!   row at or below it as a duplicate, so a deleted row never comes back.
//! - [`VACUUM_KEY`]: set when a chunk leaves more than [`VACUUM_FREE_RATIO`]
//!   of the file's pages on the freelist (`PRAGMA freelist_count /
//!   page_count`); [`vacuum_if_due`] runs `VACUUM` once at the next startup.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::hlc::Hlc;
use super::image::{IMAGE_VERSION, REG_BODY, REG_PLACE};
use super::{journal, ENTITY_ASSET, ENTITY_BOARD, ENTITY_CARD};
use crate::app::Workspace;
use crate::domain::card_kind::CardKind;
use crate::domain::errors::WorkspaceError;
use crate::domain::mutation::Mutation;

/// Rows whose entities one chunk (one transaction) examines.
pub const CHUNK_ROWS: usize = 2_000;
/// G of R2: how long a cross-device body edit keeps its lineage rows.
pub const LINEAGE_GRACE_MS: u64 = 90 * 24 * 60 * 60 * 1_000;
/// Free share of the database file above which the next startup vacuums.
pub const VACUUM_FREE_RATIO: f64 = 0.25;

pub const SEQ_KEY: &str = "journal_compact_seq";
pub const AGED_KEY: &str = "journal_compact_aged";
pub const HEADS_KEY: &str = "journal_compact_heads";
pub const FLOOR_KEY: &str = "journal_compact_floor";
pub const VACUUM_KEY: &str = "journal_vacuum_due";

/// What one chunk did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactReport {
    /// Entities examined.
    pub entities: usize,
    /// Rows deleted.
    pub deleted: usize,
    /// Nothing left to examine: another chunk now would do nothing.
    pub done: bool,
}

fn meta(conn: &Connection, key: &str) -> Result<Option<String>, WorkspaceError> {
    Ok(conn
        .prepare_cached("SELECT value FROM local_meta WHERE key = ?1")?
        .query_row([key], |r| r.get(0))
        .optional()?)
}

fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<(), WorkspaceError> {
    conn.prepare_cached(
        "INSERT INTO local_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )?
    .execute(params![key, value])?;
    Ok(())
}

fn meta_map(conn: &Connection, key: &str) -> Result<BTreeMap<String, String>, WorkspaceError> {
    Ok(meta(conn, key)?
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default())
}

fn set_meta_map(
    conn: &Connection,
    key: &str,
    map: &BTreeMap<String, String>,
) -> Result<(), WorkspaceError> {
    set_meta(conn, key, &serde_json::to_string(map).unwrap_or_default())
}

/// Per origin, the highest HLC compaction deleted here (see [`FLOOR_KEY`]).
pub fn floor(conn: &Connection) -> Result<BTreeMap<String, String>, WorkspaceError> {
    meta_map(conn, FLOOR_KEY)
}

/// [`floor`] for compaction itself: an unreadable value refuses the chunk.
fn floor_to_extend(conn: &Connection) -> Result<BTreeMap<String, String>, WorkspaceError> {
    let Some(text) = meta(conn, FLOOR_KEY)? else {
        return Ok(BTreeMap::new());
    };
    // Сброс в пустой floor здесь нельзя: чанк записал бы вместо него только
    // свои удаления, и строки, удалённые раньше, реплей принял бы обратно
    // как новые. Ошибка откатывает транзакцию чанка, писатель её логирует.
    serde_json::from_str(&text).map_err(|e| {
        WorkspaceError::Database(format!(
            "journal compaction refused: {FLOOR_KEY} is unreadable ({e})"
        ))
    })
}

/// True until the first chunk commits: the caller takes a backup first.
pub fn never_compacted(conn: &Connection) -> Result<bool, WorkspaceError> {
    Ok(meta(conn, SEQ_KEY)?.is_none())
}

/// The part of a payload compaction reads; the entity state is skipped.
#[derive(Deserialize)]
struct Lineage {
    v: u32,
    #[serde(default)]
    purge: bool,
    #[serde(default)]
    clocks: BTreeMap<String, String>,
    #[serde(default)]
    prev: BTreeMap<String, String>,
    #[serde(default)]
    state: Option<StateHead>,
}

/// What a card or board image says about kind and placement.
#[derive(Deserialize, PartialEq)]
struct StateHead {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    board_id: Option<String>,
    #[serde(default)]
    parent_board_id: Option<String>,
}

/// A card's board and a board's parent.
type Placement<'a> = (&'a Option<String>, &'a Option<String>);

impl Lineage {
    /// The board a card is on or the parent of a board.
    fn placement(&self) -> Option<Placement<'_>> {
        self.state
            .as_ref()
            .map(|s| (&s.board_id, &s.parent_board_id))
    }
}

struct Row {
    seq: i64,
    origin: String,
    hlc: String,
    /// `None`: a payload this build cannot read, never deleted.
    lineage: Option<Lineage>,
}

/// True when `a` matches or beats `b` on every register `b` has.
fn dominates(a: &Lineage, b: &Lineage) -> bool {
    b.clocks
        .iter()
        .all(|(reg, clock)| a.clocks.get(reg).is_some_and(|mine| mine >= clock))
}

fn hlc_wall(hlc: &str) -> Option<u64> {
    hlc.parse::<Hlc>().ok().map(|h| h.wall_ms)
}

fn device_of(hlc: &str) -> Option<String> {
    hlc.parse::<Hlc>().ok().map(|h| h.device_id)
}

/// Each origin's newest row: `origin → hlc`.
fn heads(conn: &Connection) -> Result<BTreeMap<String, String>, WorkspaceError> {
    let mut max =
        conn.prepare_cached("SELECT MAX(hlc) FROM changes WHERE origin_device_id = ?1")?;
    let mut heads = BTreeMap::new();
    for origin in journal::origins(conn)? {
        if let Some(hlc) = max.query_row([&origin], |r| r.get::<_, Option<String>>(0))? {
            heads.insert(origin, hlc);
        }
    }
    Ok(heads)
}

fn entity_of(
    conn: &Connection,
    origin: &str,
    hlc: &str,
) -> Result<Option<(String, String)>, WorkspaceError> {
    Ok(conn
        .prepare_cached(
            "SELECT entity_kind, entity_id FROM changes WHERE origin_device_id = ?1 AND hlc = ?2",
        )?
        .query_row(params![origin, hlc], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?)
}

fn is_purged(conn: &Connection, kind: &str, id: &str) -> Result<bool, WorkspaceError> {
    Ok(conn
        .prepare_cached("SELECT 1 FROM purged WHERE entity_kind = ?1 AND entity_id = ?2")?
        .query_row(params![kind, id], |_| Ok(()))
        .optional()?
        .is_some())
}

fn load_rows(conn: &Connection, kind: &str, id: &str) -> Result<Vec<Row>, WorkspaceError> {
    let mut stmt = conn.prepare_cached(
        "SELECT seq, origin_device_id, hlc, payload_json FROM changes
         WHERE entity_kind = ?1 AND entity_id = ?2",
    )?;
    let rows = stmt.query_map(params![kind, id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (seq, origin, hlc, payload) = row?;
        let lineage = serde_json::from_str::<Lineage>(&payload)
            .ok()
            .filter(|l| l.v == IMAGE_VERSION);
        out.push(Row {
            seq,
            origin,
            hlc,
            lineage,
        });
    }
    // Newest first: a row's HLC is the highest of its clocks, so a row can
    // only be dominated by one that comes before it in this order.
    out.sort_by(|a, b| b.hlc.cmp(&a.hlc));
    Ok(out)
}

/// The rows of one entity that compaction may delete (R1–R3).
fn deletable(
    conn: &Connection,
    kind: &str,
    id: &str,
    heads: &HashSet<(&str, &str)>,
    now_ms: u64,
) -> Result<Vec<Row>, WorkspaceError> {
    let rows = load_rows(conn, kind, id)?;
    let is_purge = |r: &Row| r.lineage.as_ref().is_some_and(|l| l.purge);
    let mut keep: HashSet<i64> = rows
        .iter()
        .filter(|r| {
            r.lineage.is_none()
                || is_purge(r)
                || heads.contains(&(r.origin.as_str(), r.hlc.as_str()))
        })
        .map(|r| r.seq)
        .collect();

    if is_purged(conn, kind, id)? {
        // R3: only a card with a purge row of its own (see the module doc).
        if kind != ENTITY_CARD || !rows.iter().any(is_purge) {
            return Ok(Vec::new());
        }
        return Ok(rows
            .into_iter()
            .filter(|r| !keep.contains(&r.seq))
            .collect());
    }

    // R2 for notes: the rows `conflict_copy_plan` and `prev_of` read.
    let newest_kind = rows
        .iter()
        .find_map(|r| r.lineage.as_ref()?.state.as_ref()?.kind.clone());
    if kind == ENTITY_CARD && newest_kind.as_deref() == Some(CardKind::Note.as_str()) {
        let body: Option<String> = conn
            .prepare_cached(
                "SELECT hlc FROM entity_clocks
                 WHERE entity_kind = ?1 AND entity_id = ?2 AND field = ?3",
            )?
            .query_row(params![kind, id, REG_BODY], |r| r.get(0))
            .optional()?;
        let mut lineage_hlcs: BTreeSet<&str> = BTreeSet::new();
        if let Some(body) = &body {
            lineage_hlcs.insert(body);
        }
        for row in &rows {
            let Some(l) = &row.lineage else { continue };
            let (Some(set), Some(prev)) = (l.clocks.get(REG_BODY), l.prev.get(REG_BODY)) else {
                continue;
            };
            let young = hlc_wall(&row.hlc)
                .is_some_and(|wall| wall.saturating_add(LINEAGE_GRACE_MS) > now_ms);
            if *set == row.hlc && young && device_of(prev).as_deref() != Some(&row.origin) {
                lineage_hlcs.insert(&row.hlc);
                lineage_hlcs.insert(prev);
            }
        }
        keep.extend(
            rows.iter()
                .filter(|r| lineage_hlcs.contains(r.hlc.as_str()))
                .map(|r| r.seq),
        );
    }

    // R1: the maximal rows form a small antichain (one per concurrent
    // branch); every other row is dominated by one of them.
    let mut maximal: Vec<&Lineage> = Vec::new();
    let mut dominated: HashSet<i64> = HashSet::new();
    for row in &rows {
        let Some(l) = &row.lineage else { continue };
        if l.purge || l.clocks.is_empty() {
            continue;
        }
        if maximal.iter().any(|m| dominates(m, l)) {
            dominated.insert(row.seq);
        } else {
            maximal.push(l);
        }
    }
    keep.extend(
        rows.iter()
            .filter(|r| !dominated.contains(&r.seq))
            .map(|r| r.seq),
    );

    // Свежая реплика создаёт сущность из самой старой удержанной строки, а
    // каскад purge (`purge_board_local`) забирает то, что лежит на доске в
    // этот момент реплея. Поэтому действующая доска (карточка) или родитель
    // (доска) в каждой точке должны совпасть с полным журналом. Действует то,
    // что выбирает LWW реплея: образ с наибольшим clock `place` на этот
    // момент, а не самый новый образ — устройство, не видевшее перенос, пишет
    // старое место со старым clock. Значит, удерживается каждая строка,
    // поднимающая clock `place` к другому месту, в том числе раньше самой
    // старой удержанной: та может нести устаревшее место, а сам перенос
    // может перекрываться более поздним сдвигом по доске. Сдвиги в пределах
    // доски не нужны.
    let mut in_effect: Option<(&String, Placement)> = None;
    for row in rows.iter().rev() {
        let Some(l) = &row.lineage else { continue };
        let (Some(here), Some(clock)) = (l.placement(), l.clocks.get(REG_PLACE)) else {
            continue;
        };
        match in_effect {
            Some((max, _)) if clock <= max => {}
            Some((_, place)) => {
                if place != here {
                    keep.insert(row.seq);
                }
                in_effect = Some((clock, here));
            }
            None => in_effect = Some((clock, here)),
        }
    }

    // Свежая реплика создаёт доску (asset) из самой старой удержанной строки.
    // Если строку создания перекрыл поздний rename, доска появляется с его
    // HLC — новее строк карточек на ней (FK: карточки на доске, asset у
    // карточки). Такие строки паркуются, и их повтор обгоняет правки, уже
    // применённые поверх, — отсюда лишняя conflict copy. Самая старая
    // строка держит создание не новее зависимых строк.
    if kind == ENTITY_BOARD || kind == ENTITY_ASSET {
        if let Some(oldest) = rows.last() {
            keep.insert(oldest.seq);
        }
    }

    Ok(rows
        .into_iter()
        .filter(|r| !keep.contains(&r.seq))
        .collect())
}

/// One bounded compaction step, inside the caller's (the writer's)
/// transaction: examines the entities of the next [`CHUNK_ROWS`] rows and
/// deletes what R1–R3 allow. `now_ms` is the wall time the R2 grace is
/// measured against.
pub fn compact_chunk(conn: &Connection, now_ms: u64) -> Result<CompactReport, WorkspaceError> {
    let seq_mark: i64 = meta(conn, SEQ_KEY)?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let cutoff = format!("{:015}-", now_ms.saturating_sub(LINEAGE_GRACE_MS));
    // The first run examines every row anyway, so the aged range starts at
    // the grace cutoff of that run.
    let stored_aged = meta(conn, AGED_KEY)?;
    let aged_mark = stored_aged.clone().unwrap_or_else(|| cutoff.clone());
    let old_heads = meta_map(conn, HEADS_KEY)?;
    let heads_now = heads(conn)?;

    let mut entities: BTreeSet<(String, String)> = BTreeSet::new();
    for (origin, hlc) in &old_heads {
        if heads_now.get(origin) != Some(hlc) {
            entities.extend(entity_of(conn, origin, hlc)?);
        }
    }

    let new_rows: Vec<(i64, String, String)> = {
        let mut stmt = conn.prepare_cached(
            "SELECT seq, entity_kind, entity_id FROM changes WHERE seq > ?1 ORDER BY seq LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![seq_mark, CHUNK_ROWS as i64], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
        rows.collect::<Result<_, _>>()?
    };
    let caught_up = new_rows.len() < CHUNK_ROWS;
    let next_seq = new_rows.last().map_or(seq_mark, |(seq, _, _)| *seq);
    entities.extend(new_rows.into_iter().map(|(_, kind, id)| (kind, id)));

    let mut next_aged = aged_mark.clone();
    let mut done = false;
    if caught_up {
        let room = CHUNK_ROWS - entities.len().min(CHUNK_ROWS);
        let aged: Vec<(String, String, String)> = {
            let mut stmt = conn.prepare_cached(
                "SELECT hlc, entity_kind, entity_id FROM changes WHERE hlc > ?1 AND hlc < ?2
                 ORDER BY hlc LIMIT ?3",
            )?;
            let rows = stmt.query_map(params![aged_mark, cutoff, room.max(1) as i64], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        done = aged.len() < room.max(1);
        if let Some((hlc, _, _)) = aged.last() {
            next_aged = hlc.clone();
        }
        entities.extend(aged.into_iter().map(|(_, kind, id)| (kind, id)));
    }

    let protected: HashSet<(&str, &str)> = heads_now
        .iter()
        .map(|(o, h)| (o.as_str(), h.as_str()))
        .collect();
    let mut floor = floor_to_extend(conn)?;
    let floor_before = floor.clone();
    let mut delete = conn.prepare_cached("DELETE FROM changes WHERE seq = ?1")?;
    let mut deleted = 0;
    for (kind, id) in &entities {
        for row in deletable(conn, kind, id, &protected, now_ms)? {
            delete.execute([row.seq])?;
            deleted += 1;
            let mark = floor.entry(row.origin).or_default();
            if row.hlc > *mark {
                *mark = row.hlc;
            }
        }
    }

    if next_seq != seq_mark || meta(conn, SEQ_KEY)?.is_none() {
        set_meta(conn, SEQ_KEY, &next_seq.to_string())?;
    }
    if stored_aged.as_deref() != Some(next_aged.as_str()) {
        set_meta(conn, AGED_KEY, &next_aged)?;
    }
    if old_heads != heads_now {
        set_meta_map(conn, HEADS_KEY, &heads_now)?;
    }
    if floor != floor_before {
        set_meta_map(conn, FLOOR_KEY, &floor)?;
    }
    if deleted > 0 && free_ratio(conn)? > VACUUM_FREE_RATIO {
        set_meta(conn, VACUUM_KEY, "1")?;
    }
    Ok(CompactReport {
        entities: entities.len(),
        deleted,
        done,
    })
}

/// Share of the database file's pages on the freelist.
pub fn free_ratio(conn: &Connection) -> Result<f64, WorkspaceError> {
    let pages: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0))?;
    let free: i64 = conn.query_row("PRAGMA freelist_count", [], |r| r.get(0))?;
    Ok(if pages > 0 {
        free as f64 / pages as f64
    } else {
        0.0
    })
}

/// `VACUUM` when a compaction asked for it (see [`VACUUM_KEY`]). Must run
/// outside any transaction. Returns whether it ran.
pub fn vacuum_if_due(conn: &Connection) -> Result<bool, WorkspaceError> {
    if meta(conn, VACUUM_KEY)?.is_none() {
        return Ok(false);
    }
    conn.execute_batch("VACUUM")?;
    conn.execute("DELETE FROM local_meta WHERE key = ?1", [VACUUM_KEY])?;
    Ok(true)
}

/// Queues compaction chunks until one reports `done` (startup maintenance).
pub fn run_blocking(ws: &Workspace) -> Result<CompactReport, WorkspaceError> {
    let mut total = CompactReport::default();
    loop {
        let chunk = ws
            .apply_blocking(Mutation::CompactJournal)?
            .into_compaction()?;
        total.entities += chunk.entities;
        total.deleted += chunk.deleted;
        if chunk.done {
            total.done = true;
            return Ok(total);
        }
    }
}

/// [`run_blocking`] for async callers (after a sync pass).
pub async fn run(ws: &Workspace) -> Result<CompactReport, WorkspaceError> {
    let mut total = CompactReport::default();
    loop {
        let chunk = ws
            .apply(Mutation::CompactJournal)
            .await?
            .into_compaction()?;
        total.entities += chunk.entities;
        total.deleted += chunk.deleted;
        if chunk.done {
            total.done = true;
            return Ok(total);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lineage(clocks: &[(&str, &str)]) -> Lineage {
        Lineage {
            v: IMAGE_VERSION,
            purge: false,
            clocks: clocks
                .iter()
                .map(|(r, c)| (r.to_string(), c.to_string()))
                .collect(),
            prev: BTreeMap::new(),
            state: None,
        }
    }

    #[test]
    fn dominance_is_per_register() {
        let old = lineage(&[("place", "1"), ("body", "1")]);
        let moved = lineage(&[("place", "2"), ("body", "1")]);
        let edited = lineage(&[("place", "1"), ("body", "3")]);
        assert!(dominates(&moved, &old));
        assert!(dominates(&old, &old), "equal clocks");
        assert!(!dominates(&moved, &edited));
        assert!(!dominates(&edited, &moved));
        assert!(
            !dominates(&lineage(&[("place", "9")]), &old),
            "a register missing"
        );
    }

    /// The aged-range bound is a prefix of every HLC of that millisecond.
    #[test]
    fn the_grace_cutoff_sorts_below_its_millisecond() {
        let cutoff = format!("{:015}-", 5u64);
        let at = Hlc {
            wall_ms: 5,
            counter: 0,
            device_id: "d".into(),
        }
        .encode();
        let before = Hlc {
            wall_ms: 4,
            counter: 99_999,
            device_id: "z".into(),
        }
        .encode();
        assert!(before < cutoff && cutoff < at);
    }
}
