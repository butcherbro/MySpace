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

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{
    AssetDto, BoardPortalDto, DuplicateBoardInput, DuplicateBoardReceipt, Frame, PortalTarget,
};
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
fn copy_board_subtree(
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

    for card in &source_cards {
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

        match card.kind.as_str() {
            "note" => {
                let (document_json, plain_text, color_token): (String, String, String) = tx.query_row(
                    "SELECT document_json, plain_text, color_token FROM note_cards WHERE card_id = ?1",
                    [card.id.as_str()],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
                tx.execute(
                    "INSERT INTO note_cards (card_id, document_json, plain_text, color_token) VALUES (?1, ?2, ?3, ?4)",
                    params![new_card_id, document_json, plain_text, color_token],
                )?;
            }
            "image" => {
                let (asset_id, caption_json, caption_plain_text): (String, String, String) = tx.query_row(
                    "SELECT asset_id, caption_json, caption_plain_text FROM image_cards WHERE card_id = ?1",
                    [card.id.as_str()],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
                tx.execute(
                    "INSERT INTO image_cards (card_id, asset_id, caption_json, caption_plain_text) VALUES (?1, ?2, ?3, ?4)",
                    params![new_card_id, asset_id, caption_json, caption_plain_text],
                )?;
            }
            "embed" => {
                #[allow(clippy::type_complexity)]
                let row: (
                    String,
                    String,
                    Option<String>,
                    Option<String>,
                    Option<String>,
                    String,
                    String,
                    Option<String>,
                    Option<String>,
                    Option<String>,
                    String,
                    Option<String>,
                    Option<String>,
                ) = tx.query_row(
                    "SELECT source_url, display_url, site_name, title, provider, description_json,
                            description_plain_text, asset_id, favicon_asset_id, preview_origin,
                            metadata_status, metadata_error, description_origin
                     FROM embed_cards WHERE card_id = ?1",
                    [card.id.as_str()],
                    |r| {
                        Ok((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                            r.get(6)?,
                            r.get(7)?,
                            r.get(8)?,
                            r.get(9)?,
                            r.get(10)?,
                            r.get(11)?,
                            r.get(12)?,
                        ))
                    },
                )?;
                tx.execute(
                    "INSERT INTO embed_cards (card_id, source_url, display_url, site_name, title, provider,
                        description_json, description_plain_text, asset_id, favicon_asset_id, preview_origin,
                        metadata_status, metadata_error, description_origin)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                    params![
                        new_card_id, row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9,
                        row.10, row.11, row.12,
                    ],
                )?;
            }
            "filesystem_alias" => {
                let (target_kind, locator_blob, path_hint, display_name): (String, Vec<u8>, String, String) = tx
                    .query_row(
                        "SELECT target_kind, locator_blob, path_hint, display_name FROM filesystem_aliases WHERE card_id = ?1",
                        [card.id.as_str()],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                    )?;
                tx.execute(
                    "INSERT INTO filesystem_aliases (card_id, target_kind, locator_blob, path_hint, display_name) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![new_card_id, target_kind, locator_blob, path_hint, display_name],
                )?;
            }
            "file" => {
                let (asset_id, mime_type, preview_text, source_path, preview_asset_id): (
                    String,
                    String,
                    String,
                    String,
                    Option<String>,
                ) = tx.query_row(
                    "SELECT asset_id, mime_type, preview_text, source_path, preview_asset_id FROM file_cards WHERE card_id = ?1",
                    [card.id.as_str()],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )?;
                tx.execute(
                    "INSERT INTO file_cards (card_id, asset_id, mime_type, preview_text, source_path, preview_asset_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![new_card_id, asset_id, mime_type, preview_text, source_path, preview_asset_id],
                )?;
            }
            "board_shortcut" => {
                // A shortcut's copy points at the SAME target board as the
                // original — it is never remapped to a duplicated descendant,
                // even if the shortcut happens to point at a board inside this
                // same subtree. See docs/decisions/0010-board-shortcuts.md.
                let target_board_id: String = tx.query_row(
                    "SELECT target_board_id FROM board_shortcut_cards WHERE card_id = ?1",
                    [card.id.as_str()],
                    |r| r.get(0),
                )?;
                tx.execute(
                    "INSERT INTO board_shortcut_cards (card_id, target_board_id) VALUES (?1, ?2)",
                    params![new_card_id, target_board_id],
                )?;
            }
            "board_portal" => {
                // A nested Board Portal: recursively duplicate its own target
                // board too, then point the copied portal card at the copy.
                let nested_target_board_id: String = tx.query_row(
                    "SELECT target_board_id FROM board_portal_cards WHERE card_id = ?1",
                    [card.id.as_str()],
                    |r| r.get(0),
                )?;
                let (nested_title, nested_color, nested_symbol, nested_cover): (
                    String,
                    String,
                    Option<String>,
                    Option<String>,
                ) = tx.query_row(
                    "SELECT title, color_token, symbol, cover_asset_id FROM boards WHERE id = ?1",
                    [nested_target_board_id.as_str()],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )?;
                let nested_new_board_id = uuid::Uuid::now_v7().to_string();
                copy_board_subtree(
                    tx,
                    &nested_target_board_id,
                    &nested_new_board_id,
                    workspace_id,
                    new_board_id,
                    &nested_title,
                    &nested_color,
                    nested_symbol.as_deref(),
                    nested_cover.as_deref(),
                    now,
                    depth + 1,
                )?;
                tx.execute(
                    "INSERT INTO board_portal_cards (card_id, target_board_id) VALUES (?1, ?2)",
                    params![new_card_id, nested_new_board_id],
                )?;
            }
            other => {
                return Err(WorkspaceError::Database(format!(
                    "duplicate_board: unrecognised card kind '{other}'"
                )));
            }
        }
    }

    Ok(())
}

/// Loads the freshly-created portal's full projection, the same shape the
/// board-snapshot read model produces, so the frontend can place it on the
/// canvas from this one response.
fn load_portal_dto(
    tx: &Transaction,
    portal_card_id: &str,
) -> Result<BoardPortalDto, WorkspaceError> {
    tx.query_row(
        "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
                p.target_board_id, b.revision, b.title, b.color_token, b.symbol,
                (SELECT COUNT(*) FROM boards cb
                 WHERE cb.parent_board_id = p.target_board_id AND cb.deleted_at IS NULL) AS child_board_count,
                (SELECT COUNT(*) FROM cards cc
                 WHERE cc.board_id = p.target_board_id AND cc.deleted_at IS NULL) AS child_card_count,
                ca.id, ca.file_name, ca.mime_type, ca.width, ca.height, ca.size_bytes, ca.file_path
         FROM cards c
         JOIN board_portal_cards p ON p.card_id = c.id
         JOIN boards b ON b.id = p.target_board_id
         LEFT JOIN assets ca ON ca.id = b.cover_asset_id
         WHERE c.id = ?1",
        [portal_card_id],
        |row| {
            let cover_asset = if row.get::<_, Option<String>>(15)?.is_some() {
                Some(AssetDto {
                    id: row.get(15)?,
                    file_name: row.get(16)?,
                    mime_type: row.get(17)?,
                    width: row.get(18)?,
                    height: row.get(19)?,
                    size_bytes: row.get(20)?,
                    file_path: row.get(21)?,
                })
            } else {
                None
            };
            Ok(BoardPortalDto {
                id: row.get(0)?,
                board_id: row.get(1)?,
                frame: Frame {
                    x: row.get(2)?,
                    y: row.get(3)?,
                    width: row.get(4)?,
                    height: row.get(5)?,
                },
                z_index: row.get(6)?,
                revision: row.get(7)?,
                target: PortalTarget {
                    id: row.get(8)?,
                    board_revision: row.get(9)?,
                    title: row.get(10)?,
                    color_token: row.get(11)?,
                    symbol: row.get(12)?,
                    child_board_count: row.get(13)?,
                    child_card_count: row.get(14)?,
                    cover_asset,
                },
            })
        },
    )
    .map_err(WorkspaceError::from)
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

    let portal = load_portal_dto(&tx, &input.new_portal_card_id)?;

    tx.commit()?;

    Ok(DuplicateBoardReceipt {
        new_board_id: input.new_board_id.clone(),
        portal,
    })
}
