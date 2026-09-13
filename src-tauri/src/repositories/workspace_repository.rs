//! Repository for reading board snapshots and creating notes.
//!
//! SQLite is authoritative (ADR-003). These functions are the only place that
//! maps database rows to domain DTOs and back.

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{AssetDto, Frame, SearchResultDto};

// Quick Boards live in their own aggregate module; re-exported so every existing
// `workspace_repository::…` path keeps working.
pub use super::assets::*;
pub use super::boards::*;
pub use super::cards::*;
pub use super::quick_boards::*;

/// A stored receipt for an operation that changed several aggregates (ADR-0007).
pub struct StoredReceipt {
    pub operation_id: String,
    pub request_fingerprint: String,
    pub receipt_json: String,
}

/// Looks a receipt up by its idempotency key. A hit means the operation already
/// committed, so the caller returns the original receipt instead of replaying the
/// move against revisions that are now stale.
pub fn find_operation_receipt(
    conn: &Connection,
    operation_kind: &str,
    idempotency_key: &str,
) -> Result<Option<StoredReceipt>, WorkspaceError> {
    conn.query_row(
        "SELECT operation_id, request_fingerprint, receipt_json FROM operation_receipts
         WHERE operation_kind = ?1 AND idempotency_key = ?2",
        params![operation_kind, idempotency_key],
        |row| {
            Ok(StoredReceipt {
                operation_id: row.get(0)?,
                request_fingerprint: row.get(1)?,
                receipt_json: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(WorkspaceError::from)
}

/// Stores a receipt inside the caller's transaction, so the receipt and the
/// aggregates it describes commit or roll back together (ADR-0007 rule 5).
#[allow(clippy::too_many_arguments)]
pub fn store_operation_receipt(
    tx: &Transaction<'_>,
    operation_id: &str,
    operation_kind: &str,
    idempotency_key: &str,
    request_fingerprint: &str,
    receipt_json: &str,
    created_at: i64,
) -> Result<(), WorkspaceError> {
    tx.execute(
        "INSERT INTO operation_receipts (operation_id, operation_kind, idempotency_key, request_fingerprint, receipt_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            operation_id,
            operation_kind,
            idempotency_key,
            request_fingerprint,
            receipt_json,
            created_at
        ],
    )?;
    Ok(())
}

/// Maximum Unicode scalar values for a search result title/excerpt.
const SEARCH_EXCERPT_LIMIT: usize = 120;

/// Maximum search results returned by the V1 read model.
const SEARCH_RESULT_LIMIT: usize = 50;

fn bound_text(text: &str) -> String {
    text.trim().chars().take(SEARCH_EXCERPT_LIMIT).collect()
}

/// Returns a bounded context snippet centered on the first case-insensitive
/// match of `query`, with ellipses where text is trimmed. Falls back to the
/// start of the text when there is no match.
fn search_excerpt(text: &str, query: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let query_folded: Vec<char> = query.to_lowercase().chars().collect();
    let Some(match_range) = folded_match_range(&chars, &query_folded) else {
        return bound_text(text);
    };

    let context_start = match_range.start.saturating_sub(40);
    let context_end = (match_range.end + 40).min(chars.len());

    let mut out = String::new();
    if context_start > 0 {
        out.push('…');
    }
    for ch in &chars[context_start..context_end] {
        out.push(*ch);
    }
    if context_end < chars.len() {
        out.push('…');
    }
    out.trim().to_string()
}

/// Where the first case-insensitive match of `needle_folded` (an already
/// lowercased query) sits in `chars`, as original character indices.
///
/// Case folding changes length: `İ` folds to `i` plus a combining dot and `ß` to
/// two `s`, so an offset measured in the folded text means nothing for the
/// original one — applying it slices inside a multibyte character. Every folded
/// character therefore remembers the original character it came from, and only
/// original indices are ever returned.
fn folded_match_range(chars: &[char], needle_folded: &[char]) -> Option<std::ops::Range<usize>> {
    if needle_folded.is_empty() {
        return None;
    }

    let mut folded: Vec<char> = Vec::new();
    let mut origin: Vec<usize> = Vec::new();
    for (index, ch) in chars.iter().enumerate() {
        for piece in ch.to_lowercase() {
            folded.push(piece);
            origin.push(index);
        }
    }

    if folded.len() < needle_folded.len() {
        return None;
    }
    let start = folded
        .windows(needle_folded.len())
        .position(|window| window == needle_folded)?;
    let first = origin[start];
    let last = origin[start + needle_folded.len() - 1];
    Some(first..last + 1)
}

/// Unicode-aware case-insensitive substring test. SQLite's `LIKE` is only
/// case-insensitive for ASCII, so Cyrillic (and other non-ASCII) must be matched
/// in Rust via `to_lowercase`.
fn contains_query(haystack: &str, query_lower: &str) -> bool {
    haystack.to_lowercase().contains(query_lower)
}

/// A search hit plus the rank used to order results deterministically.
struct SearchHit {
    entity_id: String,
    kind: &'static str,
    title: String,
    excerpt: Option<String>,
    board_id: String,
    rank: i64,
    thumbnail_asset: Option<AssetDto>,
    created_at: i64,
}

/// Searches the workspace (Board titles, Note plain text, Link Card title/URL/
/// description) and returns a bounded, deterministic result set. This is the V1
/// default: global scope and a title-before-body ordering; both are documented
/// in `docs/specs/search.md` and may be refined after agreement.
pub fn search_workspace(
    conn: &Connection,
    query: &str,
) -> Result<Vec<SearchResultDto>, WorkspaceError> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let q = query.to_lowercase();
    let mut hits = Vec::<SearchHit>::new();

    // Boards by title (rank 0).
    {
        let mut stmt = conn.prepare(
            "SELECT b.id, b.title, b.created_at,
                    ca.id, ca.file_name, ca.mime_type, ca.width, ca.height, ca.size_bytes, ca.file_path
             FROM boards b
             LEFT JOIN assets ca ON ca.id = b.cover_asset_id
             WHERE b.deleted_at IS NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            let cover = if row.get::<_, Option<String>>(3)?.is_some() {
                Some(AssetDto {
                    id: row.get(3)?,
                    file_name: row.get(4)?,
                    mime_type: row.get(5)?,
                    width: row.get(6)?,
                    height: row.get(7)?,
                    size_bytes: row.get(8)?,
                    file_path: row.get(9)?,
                })
            } else {
                None
            };
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                cover,
            ))
        })?;
        for r in rows {
            let (id, title, created_at, cover) = r?;
            if contains_query(&title, &q) {
                hits.push(SearchHit {
                    entity_id: id.clone(),
                    kind: "board",
                    title: bound_text(&title),
                    excerpt: None,
                    board_id: id,
                    rank: 0,
                    thumbnail_asset: cover,
                    created_at,
                });
            }
        }
    }

    // Notes by plain text (rank 1).
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, n.plain_text, c.created_at
             FROM cards c
             JOIN note_cards n ON n.card_id = c.id
             JOIN boards b ON b.id = c.board_id AND b.deleted_at IS NULL
             WHERE c.deleted_at IS NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?;
        for r in rows {
            let (id, board_id, plain_text, created_at) = r?;
            if contains_query(&plain_text, &q) {
                hits.push(SearchHit {
                    entity_id: id,
                    kind: "note",
                    title: search_excerpt(&plain_text, query),
                    excerpt: None,
                    board_id,
                    rank: 1,
                    thumbnail_asset: None,
                    created_at,
                });
            }
        }
    }

    // Image cards by caption or file name (rank 1).
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, i.caption_plain_text, c.created_at,
                    a.id, a.file_name, a.mime_type, a.width, a.height, a.size_bytes, a.file_path
             FROM cards c
             JOIN image_cards i ON i.card_id = c.id
             JOIN assets a ON a.id = i.asset_id
             JOIN boards b ON b.id = c.board_id AND b.deleted_at IS NULL
             WHERE c.deleted_at IS NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            let thumb = AssetDto {
                id: row.get(4)?,
                file_name: row.get(5)?,
                mime_type: row.get(6)?,
                width: row.get(7)?,
                height: row.get(8)?,
                size_bytes: row.get(9)?,
                file_path: row.get(10)?,
            };
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                thumb,
            ))
        })?;
        for r in rows {
            let (id, board_id, caption, created_at, thumb) = r?;
            let file_name = thumb.file_name.clone();
            if contains_query(&caption, &q) || contains_query(&file_name, &q) {
                let title = if caption.trim().is_empty() {
                    file_name
                } else {
                    caption
                };
                hits.push(SearchHit {
                    entity_id: id,
                    kind: "image",
                    title: search_excerpt(&title, query),
                    excerpt: None,
                    board_id,
                    rank: 1,
                    thumbnail_asset: Some(thumb),
                    created_at,
                });
            }
        }
    }

    // Folder shortcuts by display name or the display-only path hint.
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, a.display_name, a.path_hint, c.created_at
             FROM cards c
             JOIN filesystem_aliases a ON a.card_id = c.id
             JOIN boards b ON b.id = c.board_id AND b.deleted_at IS NULL
             WHERE c.deleted_at IS NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;
        for row in rows {
            let (id, board_id, display_name, path_hint, created_at) = row?;
            let name_match = contains_query(&display_name, &q);
            let path_match = contains_query(&path_hint, &q);
            if name_match || path_match {
                hits.push(SearchHit {
                    entity_id: id,
                    kind: "folder",
                    title: bound_text(&display_name),
                    excerpt: (!name_match).then(|| bound_text(&path_hint)),
                    board_id,
                    rank: if name_match { 0 } else { 1 },
                    thumbnail_asset: None,
                    created_at,
                });
            }
        }
    }

    // Link Cards (embed) by title, URL, or description.
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, e.title, e.source_url, e.display_url, e.description_plain_text,
                    pa.id, pa.file_name, pa.mime_type, pa.width, pa.height, pa.size_bytes, pa.file_path,
                    fa.id, fa.file_name, fa.mime_type, fa.width, fa.height, fa.size_bytes, fa.file_path,
                    c.created_at
             FROM cards c
             JOIN embed_cards e ON e.card_id = c.id
             JOIN boards b ON b.id = c.board_id AND b.deleted_at IS NULL
             LEFT JOIN assets pa ON pa.id = e.asset_id
             LEFT JOIN assets fa ON fa.id = e.favicon_asset_id
             WHERE c.deleted_at IS NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            let preview = if row.get::<_, Option<String>>(6)?.is_some() {
                Some(AssetDto {
                    id: row.get(6)?,
                    file_name: row.get(7)?,
                    mime_type: row.get(8)?,
                    width: row.get(9)?,
                    height: row.get(10)?,
                    size_bytes: row.get(11)?,
                    file_path: row.get(12)?,
                })
            } else {
                None
            };
            let favicon = if row.get::<_, Option<String>>(13)?.is_some() {
                Some(AssetDto {
                    id: row.get(13)?,
                    file_name: row.get(14)?,
                    mime_type: row.get(15)?,
                    width: row.get(16)?,
                    height: row.get(17)?,
                    size_bytes: row.get(18)?,
                    file_path: row.get(19)?,
                })
            } else {
                None
            };
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                preview.or(favicon),
                row.get::<_, i64>(20)?,
            ))
        })?;
        for r in rows {
            let (id, board_id, title_raw, source_url, display_url, description, thumb, created_at) =
                r?;
            let title = title_raw
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| source_url.clone());

            let title_match = contains_query(&title, &q);
            let source_match = contains_query(&source_url, &q);
            let display_match = contains_query(&display_url, &q);
            let desc_match = contains_query(&description, &q);

            if !(title_match || source_match || display_match || desc_match) {
                continue;
            }

            let (rank, excerpt) = if title_match || source_match || display_match {
                (0, None)
            } else {
                (2, Some(search_excerpt(&description, query)))
            };

            hits.push(SearchHit {
                entity_id: id,
                kind: "link",
                title,
                excerpt,
                board_id,
                rank,
                thumbnail_asset: thumb,
                created_at,
            });
        }
    }

    // Deterministic ordering: rank first, then title, then entity id.
    hits.sort_by(|a, b| {
        a.rank
            .cmp(&b.rank)
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
            .then_with(|| a.entity_id.cmp(&b.entity_id))
    });
    hits.truncate(SEARCH_RESULT_LIMIT);

    // Fetch each board's identity once, so results carry the same cover/icon/
    // acronym fallback as the rest of the UI (no duplicated identity logic).
    let mut identity_cache: std::collections::HashMap<
        String,
        (String, Option<String>, Option<AssetDto>),
    > = std::collections::HashMap::new();
    for hit in &hits {
        if identity_cache.contains_key(&hit.board_id) {
            continue;
        }
        let summary = load_board_summary(conn, &hit.board_id)?;
        identity_cache.insert(
            hit.board_id.clone(),
            (summary.color_token, summary.symbol, summary.cover_asset),
        );
    }

    let mut out = Vec::with_capacity(hits.len());
    for hit in hits {
        let board_trail = load_breadcrumbs(conn, &hit.board_id)?;
        let (board_color_token, board_symbol, board_cover_asset) = identity_cache
            .get(&hit.board_id)
            .cloned()
            .unwrap_or((String::new(), None, None));
        out.push(SearchResultDto {
            entity_id: hit.entity_id,
            kind: hit.kind.to_string(),
            title: hit.title,
            excerpt: hit.excerpt,
            board_id: hit.board_id,
            board_trail,
            board_color_token,
            board_symbol,
            board_cover_asset,
            thumbnail_asset: hit.thumbnail_asset,
            created_at: hit.created_at,
        });
    }
    Ok(out)
}

/// Reads the pre-move state of a mixed selection. It runs inside the caller's
/// Immediate transaction, so the values cannot change under the caller, and it
/// rejects a leaf that is missing or trashed, a Board Portal offered as a leaf,
/// and a board without an active portal (ADR-0007 rules 2-3).
pub fn read_selection_pre_state(
    conn: &Connection,
    input: &crate::domain::models::MoveSelectionToBoardInput,
) -> Result<crate::domain::move_selection::SelectionPreState, WorkspaceError> {
    use crate::domain::move_selection::{SelectedBoardState, SelectedCardState, SelectionPreState};

    let mut cards = Vec::with_capacity(input.cards.len());
    for item in &input.cards {
        let state = conn
            .query_row(
                "SELECT kind, board_id, x, y, width, height, unsorted, revision FROM cards
                 WHERE id = ?1 AND deleted_at IS NULL",
                [item.id.as_str()],
                |row| {
                    Ok(SelectedCardState {
                        id: item.id.clone(),
                        kind: row.get(0)?,
                        board_id: row.get(1)?,
                        frame: Frame {
                            x: row.get(2)?,
                            y: row.get(3)?,
                            width: row.get(4)?,
                            height: row.get(5)?,
                        },
                        unsorted: row.get::<_, i64>(6)? == 1,
                        revision: row.get(7)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| WorkspaceError::NotFound(item.id.clone()))?;
        if state.kind == "board_portal" {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "board portal {} must be moved as a board, not as a leaf",
                item.id
            )));
        }
        cards.push(state);
    }

    let mut boards = Vec::with_capacity(input.boards.len());
    for item in &input.boards {
        let (parent_board_id, board_revision): (Option<String>, i64) = conn
            .query_row(
                "SELECT parent_board_id, revision FROM boards WHERE id = ?1 AND deleted_at IS NULL",
                [item.board_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| WorkspaceError::NotFound(item.board_id.clone()))?;
        let (portal_card_id, portal_frame, portal_revision) = conn
            .query_row(
                "SELECT c.id, c.x, c.y, c.width, c.height, c.revision
                 FROM board_portal_cards p JOIN cards c ON c.id = p.card_id
                 WHERE p.target_board_id = ?1 AND c.deleted_at IS NULL",
                [item.board_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        Frame {
                            x: row.get(1)?,
                            y: row.get(2)?,
                            width: row.get(3)?,
                            height: row.get(4)?,
                        },
                        row.get(5)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| {
                WorkspaceError::ConstraintViolation(format!(
                    "board {} has no active portal card",
                    item.board_id
                ))
            })?;
        boards.push(SelectedBoardState {
            board_id: item.board_id.clone(),
            parent_board_id,
            board_revision,
            portal_card_id,
            portal_frame,
            portal_revision,
        });
    }

    Ok(SelectionPreState { cards, boards })
}

/// True when `candidate_board_id` lies inside the subtree rooted at
/// `root_board_id` (the root itself counts).
fn is_in_subtree(
    conn: &Connection,
    root_board_id: &str,
    candidate_board_id: &str,
) -> Result<bool, WorkspaceError> {
    let count: i64 = conn.query_row(
        "WITH RECURSIVE subtree(id) AS (
            SELECT id FROM boards WHERE id = ?1
            UNION ALL
            SELECT b.id FROM boards b JOIN subtree s ON b.parent_board_id = s.id
         )
         SELECT COUNT(*) FROM subtree WHERE id = ?2",
        params![root_board_id, candidate_board_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Rejects a mixed-selection move that would detach a subtree from the workspace
/// root: the root board may not travel at all, and the destination may not sit
/// inside a board that moves with the selection (ADR-0007 rule 2).
pub fn validate_selection_cycle(
    conn: &Connection,
    target_board_id: &str,
    state: &crate::domain::move_selection::SelectionPreState,
) -> Result<(), WorkspaceError> {
    for board in &state.boards {
        if board.parent_board_id.is_none() {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "board {} is the workspace root and cannot be moved",
                board.board_id
            )));
        }
        if is_in_subtree(conn, &board.board_id, target_board_id)? {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "board {} cannot be moved inside its own subtree",
                board.board_id
            )));
        }
    }
    Ok(())
}
