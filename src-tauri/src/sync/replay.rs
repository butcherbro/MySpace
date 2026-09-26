//! Replaying a peer's journal rows (ADR-0011 S2, Decision 3).
//!
//! [`apply_remote`] runs inside the writer's transaction (it is the body of
//! `Mutation::ApplySyncChanges`). For each row, in HLC order:
//!
//! 1. `(origin, hlc)` already in `changes` → duplicate, ignored (idempotent).
//! 2. Otherwise the row is stored in `changes` with its ORIGINAL origin and
//!    HLC (so this device serves it onward), the origin's cursor advances and
//!    the local clock moves past it (`Hlc::receive`).
//! 3. Entity in `purged` → dropped. A purge is final whatever the HLCs say:
//!    ids are never reused, so any later change of it is a stale edit.
//! 4. A tombstone purges the entity (a board with its whole local subtree).
//! 5. Otherwise registers merge by last-writer-wins: each register whose
//!    clock in the image is newer than `entity_clocks` is written (no
//!    revision precondition; `revision` still increments). An entity that does
//!    not exist yet is created from the full image.
//! 6. A missing dependency (the card's board, a referenced asset, a parent
//!    board) parks the row in `pending_changes`; parked rows are retried after
//!    the batch, in HLC order, until a pass makes no progress.
//!
//! Conflict policy as implemented:
//! - frames, board/card placement, titles, colors, covers, trash state:
//!   per-register LWW.
//! - note body (`document_json`): whole-document LWW; when the losing and
//!   winning edits are CONCURRENT (neither was made on top of the other, per
//!   the image's `prev` clock), come from different devices and differ in
//!   plain text, the losing text is kept as a new note next to the original,
//!   headed "Conflict copy". Its id is derived from the losing change, so
//!   every device that sees the conflict creates the SAME copy; the copy is
//!   journaled like any local write.
//! - trash is monotonic: an edit never touches the `life` register, so a
//!   concurrent move/edit cannot undo a trash; a restore is a newer `life`.
//! - a card or board placed onto a purged board is purged too (the origin of
//!   the purge purged everything it knew on that board).
//!
//! Replay writes nothing device-local: no locator is created for a synced
//! folder shortcut (it renders foreign, ADR-0012) and the viewport of a
//! replayed board is a fresh local default.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use super::hlc::{self, Hlc};
use super::image::{
    self, card_kind, card_place, get_opt_str, get_str, registers, Cause, Envelope, REG_BODY,
    REG_LIFE, REG_META, REG_PLACE,
};
use super::tracking::{self, load_clocks, record_purge, set_clock};
use super::{
    board_from_wire, board_to_wire, journal, ApplyReport, ChangeRow, ENTITY_ASSET, ENTITY_BOARD,
    ENTITY_CARD, ENTITY_QUICK_BOARD, OP_CONFLICT_COPY, ROOT_BOARD_ALIAS,
};
use crate::domain::card_kind::{handler, registry, CardKind};
use crate::domain::errors::WorkspaceError;
use crate::domain::plain_text::{document_to_plain_text, plain_text_to_document};
use crate::repositories::immediate_tx;

/// Retry passes over `pending_changes` after a batch.
pub const MAX_RETRY_PASSES: usize = 8;

/// Heading of a conflict-copy note.
pub const CONFLICT_COPY_TITLE: &str = "Conflict copy";

struct Ctx {
    device: String,
    root: String,
    now: i64,
}

#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Applied,
    Superseded,
    Purged,
    Park,
    Rejected,
}

/// Applies a batch of peer rows. Opens its own IMMEDIATE transaction when
/// called outside the writer funnel; inside it, a savepoint.
pub fn apply_remote(
    conn: &mut Connection,
    batch: Vec<ChangeRow>,
) -> Result<ApplyReport, WorkspaceError> {
    let tx = immediate_tx(conn)?;
    let report = apply_in_tx(&tx, batch)?;
    tx.commit()?;
    Ok(report)
}

fn change_seqs(conn: &Connection) -> Result<BTreeMap<String, i64>, WorkspaceError> {
    let mut stmt = conn.prepare("SELECT id, change_seq FROM boards")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn apply_in_tx(
    conn: &Connection,
    mut batch: Vec<ChangeRow>,
) -> Result<ApplyReport, WorkspaceError> {
    tracking::ensure_installed(conn)?;
    tracking::clear(conn)?;
    let ctx = Ctx {
        device: super::device_id(conn)?,
        root: super::root_board_id(conn)?,
        now: crate::db::migrations::now_millis(),
    };
    let seqs_before = change_seqs(conn)?;
    let mut report = ApplyReport {
        received: batch.len(),
        ..ApplyReport::default()
    };

    batch.sort_by(|a, b| {
        a.hlc
            .cmp(&b.hlc)
            .then_with(|| a.origin_device_id.cmp(&b.origin_device_id))
    });
    for row in batch {
        let hlc = match row.hlc.parse::<Hlc>() {
            Ok(hlc) if hlc.device_id == row.origin_device_id => hlc,
            _ => {
                // Not even a valid key: cannot be stored or forwarded.
                report.rejected += 1;
                continue;
            }
        };
        if !journal::insert_change(conn, &row, ctx.now)? {
            report.duplicates += 1;
            continue;
        }
        journal::advance_cursor(conn, &row.origin_device_id, &row.hlc)?;
        hlc::observe_remote(conn, &ctx.device, &hlc)?;
        match apply_one(conn, &ctx, &row, &mut report)? {
            Outcome::Park => {
                journal::park(conn, &row, ctx.now)?;
                report.parked += 1;
            }
            outcome => count(&mut report, outcome),
        }
    }

    for _ in 0..MAX_RETRY_PASSES {
        let pending = journal::pending(conn)?;
        if pending.is_empty() {
            break;
        }
        let mut progress = false;
        for row in pending {
            match apply_one(conn, &ctx, &row, &mut report)? {
                Outcome::Park => journal::bump_attempts(conn, &row.origin_device_id, &row.hlc)?,
                outcome => {
                    journal::unpark(conn, &row.origin_device_id, &row.hlc)?;
                    count(&mut report, outcome);
                    progress = true;
                }
            }
        }
        if !progress {
            break;
        }
    }
    report.pending = journal::pending_count(conn)? as usize;

    let seqs_after = change_seqs(conn)?;
    report.touched_boards = seqs_after
        .into_iter()
        .filter(|(id, seq)| seqs_before.get(id) != Some(seq))
        .map(|(id, _)| id)
        .collect();
    tracking::clear(conn)?;
    Ok(report)
}

fn count(report: &mut ApplyReport, outcome: Outcome) {
    match outcome {
        Outcome::Applied => report.applied += 1,
        Outcome::Superseded => report.superseded += 1,
        Outcome::Purged => report.dropped_purged += 1,
        Outcome::Rejected => report.rejected += 1,
        Outcome::Park => report.parked += 1,
    }
}

/// Runs one row in a savepoint: kept only when it applied; a missing
/// dependency (foreign key) parks it, an invalid payload rejects it, any
/// other error aborts the batch.
fn apply_one(
    conn: &Connection,
    ctx: &Ctx,
    row: &ChangeRow,
    report: &mut ApplyReport,
) -> Result<Outcome, WorkspaceError> {
    conn.execute_batch("SAVEPOINT sync_row")?;
    let mut copies = Vec::new();
    let result = apply_row(conn, ctx, row, &mut copies);
    let outcome = match result {
        Ok(outcome) => outcome,
        Err(WorkspaceError::Database(message))
            if message.contains("FOREIGN KEY constraint failed") =>
        {
            Outcome::Park
        }
        Err(WorkspaceError::ConstraintViolation(_)) => Outcome::Rejected,
        Err(WorkspaceError::Database(message)) if message.contains("constraint failed") => {
            Outcome::Rejected
        }
        Err(other) => {
            conn.execute_batch("ROLLBACK TO sync_row; RELEASE sync_row;")?;
            return Err(other);
        }
    };
    if outcome == Outcome::Applied {
        conn.execute_batch("RELEASE sync_row")?;
        report.conflict_copies.extend(copies);
    } else {
        if outcome == Outcome::Rejected {
            tracing::warn!(
                entity_kind = %row.entity_kind,
                op = %row.op,
                error_code = "sync_row_rejected",
                "sync: refused an invalid change row"
            );
        }
        conn.execute_batch("ROLLBACK TO sync_row; RELEASE sync_row;")?;
    }
    tracking::clear(conn)?;
    Ok(outcome)
}

fn is_purged(conn: &Connection, kind: &str, wire_id: &str) -> Result<bool, WorkspaceError> {
    Ok(conn
        .prepare_cached("SELECT 1 FROM purged WHERE entity_kind = ?1 AND entity_id = ?2")?
        .query_row(params![kind, wire_id], |_| Ok(()))
        .optional()?
        .is_some())
}

fn board_exists(conn: &Connection, id: &str) -> Result<bool, WorkspaceError> {
    Ok(conn
        .query_row("SELECT 1 FROM boards WHERE id = ?1", [id], |_| Ok(()))
        .optional()?
        .is_some())
}

/// Registers whose clock in the image beats the local one.
fn winners(kind: &str, env: &Envelope, local: &BTreeMap<String, String>) -> Vec<&'static str> {
    registers(kind)
        .iter()
        .copied()
        .filter(|reg| match (env.clocks.get(*reg), local.get(*reg)) {
            (Some(remote), Some(mine)) => remote > mine,
            (Some(_), None) => true,
            (None, _) => false,
        })
        .collect()
}

fn set_clocks(
    conn: &Connection,
    kind: &str,
    wire_id: &str,
    env: &Envelope,
    regs: &[&str],
) -> Result<(), WorkspaceError> {
    for reg in regs {
        if let Some(clock) = env.clocks.get(*reg) {
            set_clock(conn, kind, wire_id, reg, clock)?;
        }
    }
    Ok(())
}

fn apply_row(
    conn: &Connection,
    ctx: &Ctx,
    row: &ChangeRow,
    copies: &mut Vec<String>,
) -> Result<Outcome, WorkspaceError> {
    let env = Envelope::decode(&row.payload_json)?;
    let kind = row.entity_kind.as_str();
    if registers(kind).is_empty() {
        return Ok(Outcome::Rejected);
    }
    if is_purged(conn, kind, &row.entity_id)? {
        return Ok(Outcome::Purged);
    }
    if env.purge {
        return purge_entity(conn, ctx, kind, &row.entity_id, &row.hlc);
    }
    match kind {
        ENTITY_CARD => apply_card(conn, ctx, row, &env, copies),
        ENTITY_BOARD => apply_board(conn, ctx, row, &env),
        ENTITY_ASSET => apply_asset(conn, row, &env),
        ENTITY_QUICK_BOARD => apply_quick_board(conn, ctx, row, &env),
        _ => Ok(Outcome::Rejected),
    }
}

// ---- cards -------------------------------------------------------------------

/// Asset ids a card or board image references (`*asset_id` fields).
fn referenced_assets(state: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    let mut collect = |object: &serde_json::Map<String, Value>| {
        for (key, value) in object {
            if key.ends_with("asset_id") {
                if let Some(id) = value.as_str() {
                    ids.push(id.to_string());
                }
            }
        }
    };
    if let Some(object) = state.as_object() {
        collect(object);
    }
    if let Some(object) = state.get("detail").and_then(Value::as_object) {
        collect(object);
    }
    ids
}

/// Re-creates asset rows this replica no longer has (per-replica asset GC
/// may have collected a replayed asset before the card using it arrived)
/// from the newest image of that asset held in `changes`. Without this the
/// card would stay parked forever: its asset row is behind the cursor.
fn restore_missing_assets(conn: &Connection, state: &Value) -> Result<(), WorkspaceError> {
    for id in referenced_assets(state) {
        let present = conn
            .query_row("SELECT 1 FROM assets WHERE id = ?1", [&id], |_| Ok(()))
            .optional()?
            .is_some();
        if present {
            continue;
        }
        let payload: Option<String> = conn
            .query_row(
                "SELECT payload_json FROM changes WHERE entity_kind = 'asset' AND entity_id = ?1
                 ORDER BY hlc DESC LIMIT 1",
                [&id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(env) = payload.and_then(|p| Envelope::decode(&p).ok()) {
            image::upsert_asset(conn, &id, &env.state)?;
            set_clocks(conn, ENTITY_ASSET, &id, &env, &[REG_BODY])?;
        }
    }
    Ok(())
}

fn apply_card(
    conn: &Connection,
    ctx: &Ctx,
    row: &ChangeRow,
    env: &Envelope,
    copies: &mut Vec<String>,
) -> Result<Outcome, WorkspaceError> {
    let id = row.entity_id.as_str();
    let state = &env.state;
    let local = load_clocks(conn, ENTITY_CARD, id)?;
    let stored_kind: Option<String> = conn
        .query_row("SELECT kind FROM cards WHERE id = ?1", [id], |r| r.get(0))
        .optional()?;

    let Some(stored_kind) = stored_kind else {
        let board_wire = get_str(state, "board_id")?;
        if is_purged(conn, ENTITY_BOARD, board_wire)? {
            return Ok(Outcome::Purged);
        }
        if !board_exists(conn, &board_from_wire(&ctx.root, board_wire))? {
            return Ok(Outcome::Park);
        }
        restore_missing_assets(conn, state)?;
        image::insert_card(conn, id, state, &ctx.root, ctx.now)?;
        let all: Vec<&str> = registers(ENTITY_CARD).to_vec();
        set_clocks(conn, ENTITY_CARD, id, env, &all)?;
        return Ok(Outcome::Applied);
    };

    let wins = winners(ENTITY_CARD, env, &local);
    let copy = conflict_copy_plan(conn, id, &stored_kind, row, env, &local)?;
    if wins.is_empty() && copy.is_none() {
        return Ok(Outcome::Superseded);
    }

    if wins.contains(&REG_PLACE) {
        let place = card_place(state, &ctx.root)?;
        let board_wire = board_to_wire(&ctx.root, &place.board_id);
        if is_purged(conn, ENTITY_BOARD, &board_wire)? {
            purge_cards_local(conn, &[id.to_string()], &row.hlc)?;
            return Ok(Outcome::Applied);
        }
        if !board_exists(conn, &place.board_id)? {
            return Ok(Outcome::Park);
        }
        image::update_card_place(conn, id, &place)?;
    }
    if wins.contains(&REG_LIFE) {
        image::update_card_life(conn, id, state)?;
    }
    if wins.contains(&REG_BODY) {
        restore_missing_assets(conn, state)?;
        let old_kind = stored_kind.parse::<CardKind>().ok();
        image::write_card_body(conn, id, card_kind(state)?, old_kind, state, &ctx.root)?;
    }
    if !wins.is_empty() {
        image::touch_card(conn, id, ctx.now)?;
        set_clocks(conn, ENTITY_CARD, id, env, &wins)?;
    }

    if let Some(copy) = copy {
        // The replayed writes above are not journaled; the copy is.
        tracking::clear(conn)?;
        if create_conflict_copy(conn, ctx, id, &copy)? {
            let cause = Cause {
                kind: ENTITY_CARD.into(),
                id: id.to_string(),
            };
            tracking::flush(conn, OP_CONFLICT_COPY, Some(&cause))?;
            copies.push(copy.copy_id);
        }
    }
    Ok(Outcome::Applied)
}

/// The losing side of a concurrent note edit, to be kept as a copy.
struct ConflictCopy {
    copy_id: String,
    document_json: String,
    plain_text: String,
    color_token: String,
}

fn note_text(detail: &Value) -> (String, String, String) {
    let text = |k: &str| {
        detail
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let color = detail
        .get("color_token")
        .and_then(Value::as_str)
        .unwrap_or("default")
        .to_string();
    (text("document_json"), text("plain_text"), color)
}

/// Clock of the local change that set `register` last, and that change's
/// own `prev` for it (what it was made on top of), from the journal.
fn prev_of(
    conn: &Connection,
    kind: &str,
    id: &str,
    clock: &str,
    register: &str,
) -> Result<Option<String>, WorkspaceError> {
    let Ok(parsed) = clock.parse::<Hlc>() else {
        return Ok(None);
    };
    let payload: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM changes
             WHERE origin_device_id = ?1 AND hlc = ?2 AND entity_kind = ?3 AND entity_id = ?4",
            params![parsed.device_id, clock, kind, id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(payload
        .and_then(|p| Envelope::decode(&p).ok())
        .and_then(|e| e.prev.get(register).cloned()))
}

fn conflict_copy_plan(
    conn: &Connection,
    id: &str,
    stored_kind: &str,
    row: &ChangeRow,
    env: &Envelope,
    local: &BTreeMap<String, String>,
) -> Result<Option<ConflictCopy>, WorkspaceError> {
    if stored_kind != CardKind::Note.as_str()
        || get_str(&env.state, "kind")? != CardKind::Note.as_str()
    {
        return Ok(None);
    }
    let (Some(remote_clock), Some(local_clock)) = (env.clocks.get(REG_BODY), local.get(REG_BODY))
    else {
        return Ok(None);
    };
    // Only the row that set the body carries its `prev`.
    if remote_clock == local_clock || *remote_clock != row.hlc {
        return Ok(None);
    }
    let (Ok(remote), Ok(mine)) = (remote_clock.parse::<Hlc>(), local_clock.parse::<Hlc>()) else {
        return Ok(None);
    };
    if remote.device_id == mine.device_id {
        return Ok(None);
    }
    // Sequential, not concurrent: one edit was made on top of the other.
    if env.prev.get(REG_BODY) == Some(local_clock)
        || prev_of(conn, ENTITY_CARD, id, local_clock, REG_BODY)?.as_deref()
            == Some(remote_clock.as_str())
    {
        return Ok(None);
    }
    let local_detail = handler(CardKind::Note).to_payload(conn, id)?;
    let remote_detail = env.state.get("detail").cloned().unwrap_or(Value::Null);
    let (local_doc, local_plain, local_color) = note_text(&local_detail);
    let (remote_doc, remote_plain, remote_color) = note_text(&remote_detail);
    if local_plain.trim() == remote_plain.trim() {
        return Ok(None);
    }
    let (loser_clock, doc, plain, color) = if remote > mine {
        (local_clock.as_str(), local_doc, local_plain, local_color)
    } else {
        (
            remote_clock.as_str(),
            remote_doc,
            remote_plain,
            remote_color,
        )
    };
    let document = conflict_document(&doc, &plain);
    Ok(Some(ConflictCopy {
        copy_id: conflict_copy_id(id, loser_clock),
        plain_text: document_to_plain_text(&document),
        document_json: document.to_string(),
        color_token: color,
    }))
}

/// The losing document with a "Conflict copy" heading paragraph prepended.
fn conflict_document(doc_text: &str, plain: &str) -> Value {
    let heading = json!({
        "type": "paragraph",
        "content": [{ "type": "text", "text": CONFLICT_COPY_TITLE, "marks": [{ "type": "bold" }] }]
    });
    match serde_json::from_str::<Value>(doc_text) {
        Ok(Value::Object(mut doc)) if doc.get("content").is_some_and(Value::is_array) => {
            if let Some(Value::Array(content)) = doc.get_mut("content") {
                content.insert(0, heading);
            }
            Value::Object(doc)
        }
        _ => plain_text_to_document(&format!("{CONFLICT_COPY_TITLE}\n{plain}")),
    }
}

/// Deterministic id of the copy of the losing change `loser_clock` of card
/// `card_id`: every device that detects the same conflict creates the same
/// card. UUID-shaped (version nibble 8, "custom") from SHA-256.
pub fn conflict_copy_id(card_id: &str, loser_clock: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("conflict-copy:{card_id}:{loser_clock}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}

/// Creates the copy next to the original (right of it, same board). `false`
/// when it already exists (another device's copy arrived first) or was purged.
fn create_conflict_copy(
    conn: &Connection,
    ctx: &Ctx,
    original: &str,
    copy: &ConflictCopy,
) -> Result<bool, WorkspaceError> {
    let exists = conn
        .query_row("SELECT 1 FROM cards WHERE id = ?1", [&copy.copy_id], |_| {
            Ok(())
        })
        .optional()?
        .is_some();
    if exists || is_purged(conn, ENTITY_CARD, &copy.copy_id)? {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision,
                            created_at, updated_at, unsorted)
         SELECT ?1, board_id, 'note', x + width + 24, y, width, height, z_index + 1, 1, ?2, ?2, unsorted
         FROM cards WHERE id = ?3",
        params![copy.copy_id, ctx.now, original],
    )?;
    handler(CardKind::Note).from_payload(
        conn,
        &copy.copy_id,
        &json!({
            "document_json": copy.document_json,
            "plain_text": copy.plain_text,
            "color_token": copy.color_token,
        }),
    )?;
    Ok(true)
}

// ---- boards ------------------------------------------------------------------

/// True when `candidate` is `board` or one of its descendants.
fn is_self_or_descendant(
    conn: &Connection,
    board: &str,
    candidate: &str,
) -> Result<bool, WorkspaceError> {
    Ok(conn.query_row(
        "WITH RECURSIVE subtree(id) AS (
            SELECT ?1 UNION SELECT b.id FROM boards b JOIN subtree s ON b.parent_board_id = s.id
         )
         SELECT EXISTS (SELECT 1 FROM subtree WHERE id = ?2)",
        params![board, candidate],
        |r| r.get(0),
    )?)
}

fn apply_board(
    conn: &Connection,
    ctx: &Ctx,
    row: &ChangeRow,
    env: &Envelope,
) -> Result<Outcome, WorkspaceError> {
    let wire = row.entity_id.as_str();
    let id = board_from_wire(&ctx.root, wire);
    let state = &env.state;
    let local = load_clocks(conn, ENTITY_BOARD, wire)?;

    if wire == ROOT_BOARD_ALIAS {
        // Home exists everywhere and never moves or goes to the trash.
        if !winners(ENTITY_BOARD, env, &local).contains(&REG_META) {
            return Ok(Outcome::Superseded);
        }
        restore_missing_assets(conn, state)?;
        image::update_board_meta(conn, &id, state)?;
        image::touch_board(conn, &id, ctx.now)?;
        set_clocks(conn, ENTITY_BOARD, wire, env, &[REG_META])?;
        return Ok(Outcome::Applied);
    }

    let parent_wire = get_opt_str(state, "parent_board_id")?;
    if !board_exists(conn, &id)? {
        let Some(parent_wire) = parent_wire else {
            return Ok(Outcome::Rejected);
        };
        if is_purged(conn, ENTITY_BOARD, &parent_wire)? {
            return Ok(Outcome::Purged);
        }
        if !board_exists(conn, &board_from_wire(&ctx.root, &parent_wire))? {
            return Ok(Outcome::Park);
        }
        restore_missing_assets(conn, state)?;
        image::insert_board(conn, &id, state, &ctx.root, ctx.now)?;
        let all: Vec<&str> = registers(ENTITY_BOARD).to_vec();
        set_clocks(conn, ENTITY_BOARD, wire, env, &all)?;
        return Ok(Outcome::Applied);
    }

    let mut wins = winners(ENTITY_BOARD, env, &local);
    if wins.is_empty() {
        return Ok(Outcome::Superseded);
    }
    if wins.contains(&REG_PLACE) {
        let Some(parent_wire) = parent_wire else {
            return Ok(Outcome::Rejected);
        };
        if is_purged(conn, ENTITY_BOARD, &parent_wire)? {
            purge_board_local(conn, ctx, &id, &row.hlc)?;
            return Ok(Outcome::Applied);
        }
        let parent = board_from_wire(&ctx.root, &parent_wire);
        if !board_exists(conn, &parent)? {
            return Ok(Outcome::Park);
        }
        if is_self_or_descendant(conn, &id, &parent)? {
            // Concurrent moves formed a cycle: keep the local parent. The
            // register clock is not advanced, so a later move still applies.
            tracing::warn!(
                error_code = "sync_board_cycle",
                "sync: refused a board move that forms a cycle"
            );
            wins.retain(|r| *r != REG_PLACE);
        } else {
            image::update_board_parent(conn, &id, &parent)?;
        }
    }
    if wins.contains(&REG_META) {
        restore_missing_assets(conn, state)?;
        image::update_board_meta(conn, &id, state)?;
    }
    if wins.contains(&REG_LIFE) {
        image::update_board_life(conn, &id, state)?;
    }
    if wins.is_empty() {
        return Ok(Outcome::Superseded);
    }
    image::touch_board(conn, &id, ctx.now)?;
    set_clocks(conn, ENTITY_BOARD, wire, env, &wins)?;
    Ok(Outcome::Applied)
}

// ---- assets and quick boards --------------------------------------------------

fn apply_asset(
    conn: &Connection,
    row: &ChangeRow,
    env: &Envelope,
) -> Result<Outcome, WorkspaceError> {
    let local = load_clocks(conn, ENTITY_ASSET, &row.entity_id)?;
    if winners(ENTITY_ASSET, env, &local).is_empty() {
        return Ok(Outcome::Superseded);
    }
    image::upsert_asset(conn, &row.entity_id, &env.state)?;
    set_clocks(conn, ENTITY_ASSET, &row.entity_id, env, &[REG_BODY])?;
    Ok(Outcome::Applied)
}

fn apply_quick_board(
    conn: &Connection,
    ctx: &Ctx,
    row: &ChangeRow,
    env: &Envelope,
) -> Result<Outcome, WorkspaceError> {
    let local = load_clocks(conn, ENTITY_QUICK_BOARD, &row.entity_id)?;
    if winners(ENTITY_QUICK_BOARD, env, &local).is_empty() {
        return Ok(Outcome::Superseded);
    }
    let board = board_from_wire(&ctx.root, &row.entity_id);
    let present = env.state.get("present").and_then(Value::as_bool) == Some(true);
    if present && !board_exists(conn, &board)? {
        if is_purged(conn, ENTITY_BOARD, &row.entity_id)? {
            return Ok(Outcome::Purged);
        }
        return Ok(Outcome::Park);
    }
    image::write_quick_board(conn, &board, &env.state, ctx.now)?;
    set_clocks(conn, ENTITY_QUICK_BOARD, &row.entity_id, env, &[REG_BODY])?;
    Ok(Outcome::Applied)
}

// ---- purge -------------------------------------------------------------------

fn purge_entity(
    conn: &Connection,
    ctx: &Ctx,
    kind: &str,
    wire_id: &str,
    hlc: &str,
) -> Result<Outcome, WorkspaceError> {
    match kind {
        ENTITY_CARD => {
            purge_cards_local(conn, &[wire_id.to_string()], hlc)?;
            Ok(Outcome::Applied)
        }
        ENTITY_BOARD if wire_id != ROOT_BOARD_ALIAS => {
            purge_board_local(conn, ctx, &board_from_wire(&ctx.root, wire_id), hlc)?;
            Ok(Outcome::Applied)
        }
        _ => Ok(Outcome::Rejected),
    }
}

/// Hard-deletes cards (detail rows first; locators cascade) and records
/// their tombstones. Missing cards still get a tombstone.
fn purge_cards_local(conn: &Connection, ids: &[String], hlc: &str) -> Result<(), WorkspaceError> {
    for handler in registry() {
        handler.delete_details(conn, ids)?;
    }
    for id in ids {
        conn.execute("DELETE FROM cards WHERE id = ?1", [id])?;
        record_purge(conn, ENTITY_CARD, id, hlc)?;
    }
    Ok(())
}

/// Hard-deletes a board with everything that depends on it HERE: its local
/// subtree, the cards on those boards, portals and shortcuts pointing into it,
/// their view states and quick-board references. The origin of the purge did
/// the same for what it knew; anything only this device had (a card created
/// here concurrently) goes too, so the replicas converge. Tombstones for all.
fn purge_board_local(
    conn: &Connection,
    ctx: &Ctx,
    board: &str,
    hlc: &str,
) -> Result<(), WorkspaceError> {
    const SUBTREE: &str = "WITH RECURSIVE subtree(id, depth) AS (
            SELECT ?1, 0
            UNION SELECT b.id, s.depth + 1 FROM boards b JOIN subtree s ON b.parent_board_id = s.id
            WHERE s.depth < 1000
        )";
    let boards: Vec<String> = {
        let mut stmt = conn.prepare(&format!(
            "{SUBTREE} SELECT id FROM subtree GROUP BY id ORDER BY MAX(depth) DESC"
        ))?;
        let rows = stmt.query_map([board], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let cards: Vec<String> = {
        let mut stmt = conn.prepare(&format!(
            "{SUBTREE}
             SELECT id FROM cards WHERE board_id IN (SELECT id FROM subtree)
             UNION SELECT card_id FROM board_portal_cards WHERE target_board_id IN (SELECT id FROM subtree)
             UNION SELECT card_id FROM board_shortcut_cards WHERE target_board_id IN (SELECT id FROM subtree)"
        ))?;
        let rows = stmt.query_map([board], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    purge_cards_local(conn, &cards, hlc)?;
    for id in &boards {
        conn.execute("DELETE FROM board_view_states WHERE board_id = ?1", [id])?;
        conn.execute("DELETE FROM quick_boards WHERE board_id = ?1", [id])?;
        conn.execute("DELETE FROM boards WHERE id = ?1", [id])?;
        record_purge(conn, ENTITY_BOARD, &board_to_wire(&ctx.root, id), hlc)?;
    }
    // The board may not have existed here at all: the tombstone still stands.
    record_purge(conn, ENTITY_BOARD, &board_to_wire(&ctx.root, board), hlc)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflict_copy_ids_are_deterministic_uuids() {
        let a = conflict_copy_id("card", "000000000000001-00000-dev");
        assert_eq!(a, conflict_copy_id("card", "000000000000001-00000-dev"));
        assert_ne!(a, conflict_copy_id("card", "000000000000002-00000-dev"));
        let parsed = uuid::Uuid::parse_str(&a).unwrap();
        assert_eq!(parsed.get_version_num(), 8);
    }

    #[test]
    fn conflict_document_prepends_a_heading() {
        let doc = json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "mine"}]}]});
        let copy = conflict_document(&doc.to_string(), "mine");
        let plain = document_to_plain_text(&copy);
        assert!(plain.starts_with(CONFLICT_COPY_TITLE), "{plain}");
        assert!(plain.contains("mine"));
        let fallback = conflict_document("not json", "text");
        assert!(document_to_plain_text(&fallback).contains("text"));
    }
}
