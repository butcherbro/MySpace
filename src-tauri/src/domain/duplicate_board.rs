//! Duplicate a Board Portal's whole subtree (todo.md №16), recursively, in one
//! atomic transaction: on any error nothing is created at all.
//!
//! Copy-in model, same as image/file card paste: an image, embed preview,
//! favicon, or file's asset row is never duplicated on disk — the copy's
//! `asset_id` points at the same row. `asset_service::collect_orphaned_assets`
//! already counts owners with `NOT EXISTS` across every asset-owning table
//! (`image_cards`, `embed_cards.asset_id`/`favicon_asset_id`, `boards.cover_asset_id`,
//! `file_cards.asset_id`/`preview_asset_id`), not a per-card limit, so sharing an
//! asset between the original and its copy is already safe: no GC change needed.
//!
//! Undo is the existing Trash mechanism: the new portal's `trashBoard` cascades
//! to the whole freshly-created subtree (`trash_service::trash_board`), and
//! restoring that batch brings all of it back — there is nothing for this
//! module to reverse itself.

use rusqlite::{params, OptionalExtension, Transaction};

use crate::domain::card_kind::{handler, CardKind, CopyContext};
use crate::domain::errors::WorkspaceError;
use crate::domain::kinds::board_portal;
use crate::domain::models::{DuplicateBoardInput, DuplicateBoardReceipt};
use crate::repositories::immediate_tx;

/// The deepest a duplicated portal chain may nest before the copy is refused.
/// A board can in principle contain itself-shaped cycles of portals only
/// because each is a *fresh* subtree (a copy can never point back at a source
/// ancestor), so this bound exists only to keep one transaction's work
/// predictable, not to prevent an actual cycle.
pub const MAX_DUPLICATE_DEPTH: u32 = 32;

/// SQLite's `boards.title` CHECK caps length at 200.
const MAX_TITLE_LEN: usize = 200;

fn truncate_title(title: &str) -> String {
    if title.chars().count() <= MAX_TITLE_LEN {
        title.to_string()
    } else {
        title.chars().take(MAX_TITLE_LEN).collect()
    }
}

/// Finder-style unique title among the target board's direct children:
/// "<title> copy", then "<title> copy 2", "<title> copy 3", ...
fn unique_duplicate_title(
    tx: &Transaction,
    parent_board_id: &str,
    source_title: &str,
) -> Result<String, WorkspaceError> {
    let base = format!("{} copy", source_title.trim());

    let existing: std::collections::HashSet<String> = {
        let mut stmt = tx.prepare(
            "SELECT title FROM boards WHERE parent_board_id = ?1 AND deleted_at IS NULL",
        )?;
        let rows = stmt.query_map([parent_board_id], |r| r.get::<_, String>(0))?;
        let mut set = std::collections::HashSet::new();
        for r in rows {
            set.insert(r?);
        }
        set
    };

    if !existing.contains(&base) {
        return Ok(truncate_title(&base));
    }
    let mut n: u32 = 2;
    loop {
        let candidate = format!("{base} {n}");
        if !existing.contains(&candidate) {
            return Ok(truncate_title(&candidate));
        }
        n += 1;
    }
}

/// One card read from the source board before it is copied.
struct SourceCard {
    id: String,
    kind: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    z_index: i64,
    unsorted: i64,
}

/// Recursively copies `source_board_id`'s active (non-trashed) content into a
/// freshly-inserted board `new_board_id`, parented at `parent_board_id`. The
/// board's own identity (`title`/`color_token`/`symbol`/`cover_asset_id`) is
/// supplied by the caller — the top call passes the computed unique copy
/// title, every recursive call passes the nested board's own title unchanged
/// (only the root of a duplicate is renamed "... copy").
#[allow(clippy::too_many_arguments)]
pub(crate) fn copy_board_subtree(
    tx: &Transaction,
    source_board_id: &str,
    new_board_id: &str,
    workspace_id: &str,
    parent_board_id: &str,
    title: &str,
    color_token: &str,
    symbol: Option<&str>,
    cover_asset_id: Option<&str>,
    now: i64,
    depth: u32,
) -> Result<(), WorkspaceError> {
    if depth > MAX_DUPLICATE_DEPTH {
        return Err(WorkspaceError::ConstraintViolation(format!(
            "duplicate depth exceeds the limit of {MAX_DUPLICATE_DEPTH} nested boards"
        )));
    }

    tx.execute(
        "INSERT INTO boards (id, workspace_id, parent_board_id, title, color_token, symbol, cover_asset_id, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)",
        params![new_board_id, workspace_id, parent_board_id, title, color_token, symbol, cover_asset_id, now],
    )?;
    tx.execute(
        "INSERT INTO board_view_states (board_id, viewport_x, viewport_y, zoom, revision, updated_at)
         VALUES (?1, 0, 0, 1, 1, ?2)",
        params![new_board_id, now],
    )?;

    let source_cards: Vec<SourceCard> = {
        let mut stmt = tx.prepare(
            "SELECT id, kind, x, y, width, height, z_index, unsorted
             FROM cards WHERE board_id = ?1 AND deleted_at IS NULL",
        )?;
        let rows = stmt.query_map([source_board_id], |row| {
            Ok(SourceCard {
                id: row.get(0)?,
                kind: row.get(1)?,
                x: row.get(2)?,
                y: row.get(3)?,
                width: row.get(4)?,
                height: row.get(5)?,
                z_index: row.get(6)?,
                unsorted: row.get(7)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        out
    };

    let ctx = CopyContext {
        workspace_id,
        new_board_id,
        now,
        depth,
    };

    for card in &source_cards {
        // An unknown kind (a row written by a newer build) is refused before
        // anything is inserted for it; the whole duplicate rolls back.
        let kind: CardKind = card.kind.parse()?;
        // Descendant ids are backend-generated (see DuplicateBoardInput doc):
        // the set of things to copy is only known once we are inside the
        // transaction reading the source board's live content.
        let new_card_id = uuid::Uuid::now_v7().to_string();
        tx.execute(
            "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at, unsorted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9, ?10)",
            params![
                new_card_id,
                new_board_id,
                card.kind,
                card.x,
                card.y,
                card.width,
                card.height,
                card.z_index,
                now,
                card.unsorted,
            ],
        )?;

        // Each kind copies its own detail row; a nested portal recursively
        // duplicates its target board (see `kinds::board_portal`).
        handler(kind).copy_detail(tx, &card.id, &new_card_id, &ctx)?;
    }

    Ok(())
}

/// Duplicates a Board Portal's whole subtree in one Immediate transaction: on
/// any error, nothing at all was created (todo.md №16).
///
/// No cycle guard is needed (unlike `move_board`/`move_selection`): this
/// always inserts a brand-new subtree with fresh ids, so it can never make a
/// board its own ancestor, even when `target_board_id` is the source itself or
/// one of its own descendants — pasting a board's duplicate onto its own child
/// is legal and unremarkable.
pub fn duplicate_board(
    conn: &mut rusqlite::Connection,
    input: &DuplicateBoardInput,
) -> Result<DuplicateBoardReceipt, WorkspaceError> {
    input.frame.validate()?;
    let now = crate::db::migrations::now_millis();
    let tx = immediate_tx(conn)?;

    let (workspace_id, source_title, source_color, source_symbol, source_cover): (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
    ) = tx
        .query_row(
            "SELECT workspace_id, title, color_token, symbol, cover_asset_id FROM boards WHERE id = ?1 AND deleted_at IS NULL",
            [input.source_board_id.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?
        .ok_or_else(|| WorkspaceError::NotFound(input.source_board_id.clone()))?;

    let target_exists: i64 = tx.query_row(
        "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
        [input.target_board_id.as_str()],
        |r| r.get(0),
    )?;
    if target_exists == 0 {
        return Err(WorkspaceError::NotFound(input.target_board_id.clone()));
    }

    // Defensive id-reuse guard, mirroring create_child_board: a retried IPC
    // call with a stale id must never silently collide with an unrelated row.
    let board_id_taken: i64 = tx.query_row(
        "SELECT COUNT(*) FROM boards WHERE id = ?1",
        [input.new_board_id.as_str()],
        |r| r.get(0),
    )?;
    if board_id_taken > 0 {
        return Err(WorkspaceError::ConstraintViolation(format!(
            "board id {} already exists",
            input.new_board_id
        )));
    }
    let card_id_taken: i64 = tx.query_row(
        "SELECT COUNT(*) FROM cards WHERE id = ?1",
        [input.new_portal_card_id.as_str()],
        |r| r.get(0),
    )?;
    if card_id_taken > 0 {
        return Err(WorkspaceError::ConstraintViolation(format!(
            "card id {} already exists",
            input.new_portal_card_id
        )));
    }

    let title = unique_duplicate_title(&tx, &input.target_board_id, &source_title)?;

    copy_board_subtree(
        &tx,
        &input.source_board_id,
        &input.new_board_id,
        &workspace_id,
        &input.target_board_id,
        &title,
        &source_color,
        source_symbol.as_deref(),
        source_cover.as_deref(),
        now,
        1,
    )?;

    tx.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at)
         VALUES (?1, ?2, 'board_portal', ?3, ?4, ?5, ?6, 0, 1, ?7, ?7)",
        params![
            input.new_portal_card_id,
            input.target_board_id,
            input.frame.x,
            input.frame.y,
            input.frame.width,
            input.frame.height,
            now,
        ],
    )?;
    tx.execute(
        "INSERT INTO board_portal_cards (card_id, target_board_id) VALUES (?1, ?2)",
        params![input.new_portal_card_id, input.new_board_id],
    )?;

    // The same projection the board snapshot produces, so the frontend can
    // place the portal on the canvas from this one response.
    let portal = board_portal::load_portal(&tx, &input.new_portal_card_id)?;

    tx.commit()?;

    Ok(DuplicateBoardReceipt {
        new_board_id: input.new_board_id.clone(),
        portal,
    })
}
