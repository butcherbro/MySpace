//! Workspace search: the read model behind the top-bar search field. Boards
//! are matched here; every card kind contributes its own hits through
//! `CardKindHandler::search_rows` (P1.3). Ranking rules are unchanged.

use rusqlite::Connection;

use crate::domain::card_kind::{registry, SearchHit};
use crate::domain::errors::WorkspaceError;
use crate::domain::kinds::{asset_at, asset_columns};
use crate::domain::models::{AssetDto, SearchResultDto};

use super::boards::{load_board_summary, load_breadcrumbs};

/// Maximum Unicode scalar values for a search result title/excerpt.
const SEARCH_EXCERPT_LIMIT: usize = 120;

/// Maximum search results returned by the V1 read model.
const SEARCH_RESULT_LIMIT: usize = 50;

pub(crate) fn bound_text(text: &str) -> String {
    text.trim().chars().take(SEARCH_EXCERPT_LIMIT).collect()
}

/// Returns a bounded context snippet centered on the first case-insensitive
/// match of `query`, with ellipses where text is trimmed. Falls back to the
/// start of the text when there is no match.
pub(crate) fn search_excerpt(text: &str, query: &str) -> String {
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
pub(crate) fn contains_query(haystack: &str, query_lower: &str) -> bool {
    haystack.to_lowercase().contains(query_lower)
}

/// Deterministic result order — rank first, then case-folded title, then
/// entity id — truncated to `limit`. Every kind's `search_rows` and the final
/// merge use it, so truncating per kind first never changes the merged result.
pub(crate) fn rank_and_truncate(hits: &mut Vec<SearchHit>, limit: usize) {
    hits.sort_by(|a, b| {
        a.rank
            .cmp(&b.rank)
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
            .then_with(|| a.entity_id.cmp(&b.entity_id))
    });
    hits.truncate(limit);
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
        let mut stmt = conn.prepare(&format!(
            "SELECT b.id, b.title, b.created_at, {cover}
             FROM boards b
             LEFT JOIN assets ca ON ca.id = b.cover_asset_id
             WHERE b.deleted_at IS NULL",
            cover = asset_columns("ca")
        ))?;
        let rows = stmt.query_map([], |row| {
            let cover = asset_at(row, 3)?;
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

    // Cards: every registered kind contributes its own hits.
    for handler in registry() {
        hits.extend(handler.search_rows(conn, query, SEARCH_RESULT_LIMIT)?);
    }

    rank_and_truncate(&mut hits, SEARCH_RESULT_LIMIT);

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
