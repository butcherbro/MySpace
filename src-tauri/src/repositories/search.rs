//! Workspace search: the read model behind the top-bar search field.
//!
//! Matching runs on the FTS5 table `search_index` (migration 0022), which
//! SQLite triggers keep in step with boards and every searchable card detail
//! table. One FTS query yields at most [`CANDIDATE_LIMIT`] live candidates
//! (trashed cards/boards are excluded here, at query time); boards are then
//! projected here and every card kind projects its own candidates through
//! `CardKindHandler::search_rows`. Ranking (`rank_and_truncate`) and the
//! Unicode-safe excerpts are unchanged from the scan-based V1.
//!
//! Query semantics: each whitespace-separated chunk of the query becomes a
//! quoted FTS5 prefix phrase (`"chunk"*`); all chunks must match (AND),
//! case- and diacritics-insensitively, at a word start. When that finds
//! nothing for a short query (up to [`SUBSTRING_FALLBACK_MAX_CHARS`]), a
//! bounded substring scan over the index keeps mid-word matches (e.g. a
//! single Cyrillic letter inside a word) working.

use std::collections::HashMap;

use rusqlite::{params_from_iter, Connection, Row};

use crate::domain::card_kind::{handler, CardKind, SearchCandidate, SearchHit};
use crate::domain::errors::WorkspaceError;
use crate::domain::kinds::{asset_at, asset_columns};
use crate::domain::models::{AssetDto, SearchResultDto};

use super::boards::{load_board_summary, load_breadcrumbs};

/// Maximum Unicode scalar values for a search result title/excerpt.
const SEARCH_EXCERPT_LIMIT: usize = 120;

/// Maximum search results returned by the V1 read model.
const SEARCH_RESULT_LIMIT: usize = 50;

/// Maximum FTS candidates ranked in Rust. Title-level matches are taken
/// first, then the most recently indexed body matches; the final list is at
/// most [`SEARCH_RESULT_LIMIT`].
const CANDIDATE_LIMIT: usize = 200;

/// Longest query (in characters) that falls back to a substring scan when no
/// word starts with it. The scan reads every indexed row, so it is kept for
/// the short queries where word-prefix matching most often misses (a single
/// letter inside a word); a longer query with no word match — typically a
/// typo — returns nothing at index speed.
const SUBSTRING_FALLBACK_MAX_CHARS: usize = 3;

/// Chunk size for `IN (?, ?, …)` expansions (well under SQLite's bound
/// parameter limit).
const ID_CHUNK: usize = 500;

pub(crate) fn bound_text(text: &str) -> String {
    text.trim().chars().take(SEARCH_EXCERPT_LIMIT).collect()
}

/// Returns a bounded context snippet centered on the first case-insensitive
/// match of `query`, with ellipses where text is trimmed. Falls back to the
/// start of the text when there is no match.
///
/// A multi-word query that does not occur verbatim (the full-text index
/// matches words in any order) centers on the earliest matching word instead.
pub(crate) fn search_excerpt(text: &str, query: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let query_folded: Vec<char> = query.to_lowercase().chars().collect();
    let match_range = folded_match_range(&chars, &query_folded).or_else(|| {
        query
            .split_whitespace()
            .filter_map(|word| {
                let folded: Vec<char> = word.to_lowercase().chars().collect();
                folded_match_range(&chars, &folded)
            })
            .min_by_key(|range| range.start)
    });
    let Some(match_range) = match_range else {
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

/// Unicode-aware case-insensitive substring test (the mid-word fallback).
/// SQLite's `LIKE` is only case-insensitive for ASCII, so Cyrillic (and other
/// non-ASCII) must be matched in Rust via `to_lowercase`.
fn contains_query(haystack: &str, query_lower: &str) -> bool {
    haystack.to_lowercase().contains(query_lower)
}

/// Deterministic result order — rank first, then case-folded title, then
/// entity id — truncated to `limit`. Applied once to the merged hits of
/// every kind.
pub(crate) fn rank_and_truncate(hits: &mut Vec<SearchHit>, limit: usize) {
    hits.sort_by(|a, b| {
        a.rank
            .cmp(&b.rank)
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
            .then_with(|| a.entity_id.cmp(&b.entity_id))
    });
    hits.truncate(limit);
}

/// The FTS5 MATCH expression for `query`, or `None` when it has nothing to
/// search for (empty or only punctuation). Every whitespace-separated chunk
/// is quoted as an FTS5 string (inner `"` doubled) with a prefix `*`, so user
/// text is never parsed as FTS5 syntax; the tokenizer splits a chunk such as
/// `example.com` into an adjacent-word phrase.
fn fts_match_expression(query: &str) -> Option<String> {
    let phrases: Vec<String> = query
        .split_whitespace()
        .filter(|chunk| chunk.chars().any(char::is_alphanumeric))
        .map(|chunk| format!("\"{}\"*", chunk.replace('"', "\"\"")))
        .collect();
    (!phrases.is_empty()).then(|| phrases.join(" "))
}

/// Joins that keep only live entities: a card must be live and on a live
/// board; a board must be live. Trash is not mirrored in `search_index`.
const LIVE_FILTER: &str = "
    LEFT JOIN cards c ON c.id = search_index.entity_id AND search_index.kind <> 'board'
    JOIN boards b ON b.id = CASE WHEN search_index.kind = 'board'
                                 THEN search_index.entity_id ELSE c.board_id END
    WHERE b.deleted_at IS NULL
      AND (search_index.kind = 'board' OR (c.id IS NOT NULL AND c.deleted_at IS NULL))";

/// One live candidate: `(entity_id, kind, title_hit)`.
type Candidate = (String, String, bool);

/// FTS candidates for `expression`, at most [`CANDIDATE_LIMIT`]: every
/// title-level match first (the `title` column), then the remaining matches
/// newest-indexed first. Both reads walk the FTS index in rowid order and stop
/// at the limit, so neither sorts or scores the full match set — a prefix that
/// matches every note costs the same as a rare word. Final ordering is
/// `rank_and_truncate`'s, in Rust.
fn fts_candidates(conn: &Connection, expression: &str) -> Result<Vec<Candidate>, WorkspaceError> {
    let sql = format!(
        "SELECT search_index.rowid, search_index.entity_id, search_index.kind
         FROM search_index
         {LIVE_FILTER}
           AND search_index MATCH ?1
         ORDER BY search_index.rowid DESC
         LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let limit = CANDIDATE_LIMIT as i64;

    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<Candidate> = Vec::new();
    let title_expression = format!("title : ({expression})");
    let rows = stmt.query_map(rusqlite::params![title_expression, limit], |row| {
        Ok((row.get::<_, i64>(0)?, row.get(1)?, row.get(2)?))
    })?;
    for row in rows {
        let (rowid, entity_id, kind) = row?;
        seen.insert(rowid);
        out.push((entity_id, kind, true));
    }
    if out.len() < CANDIDATE_LIMIT {
        let rows = stmt.query_map(
            rusqlite::params![expression, limit + out.len() as i64],
            |row| Ok((row.get::<_, i64>(0)?, row.get(1)?, row.get(2)?)),
        )?;
        for row in rows {
            let (rowid, entity_id, kind) = row?;
            if out.len() >= CANDIDATE_LIMIT {
                break;
            }
            if !seen.contains(&rowid) {
                out.push((entity_id, kind, false));
            }
        }
    }
    Ok(out)
}

/// Mid-word fallback when the word-prefix query found nothing: a
/// case-insensitive (Unicode) substring test over the indexed text of live
/// entities, bounded to [`CANDIDATE_LIMIT`] hits (title-level hits first).
fn substring_candidates(conn: &Connection, query: &str) -> Result<Vec<Candidate>, WorkspaceError> {
    let q = query.to_lowercase();
    let mut stmt = conn.prepare(&format!(
        "SELECT search_index.entity_id, search_index.kind, search_index.title, search_index.body
         FROM search_index
         {LIVE_FILTER}"
    ))?;
    let mut rows = stmt.query([])?;
    let mut title_hits = Vec::new();
    let mut body_hits = Vec::new();
    while let Some(row) = rows.next()? {
        let title: String = row.get(2)?;
        if contains_query(&title, &q) {
            title_hits.push((row.get(0)?, row.get(1)?, true));
        } else if body_hits.len() < CANDIDATE_LIMIT {
            let body: String = row.get(3)?;
            if contains_query(&body, &q) {
                body_hits.push((row.get(0)?, row.get(1)?, false));
            }
        }
        if title_hits.len() >= CANDIDATE_LIMIT {
            break;
        }
    }
    title_hits.extend(body_hits);
    title_hits.truncate(CANDIDATE_LIMIT);
    Ok(title_hits)
}

/// Runs `sql_prefix` (a `SELECT … WHERE <id column>` without the `IN` list)
/// for `ids` in bounded chunks and maps each row. Row order follows SQLite.
pub(crate) fn query_by_ids<T, F>(
    conn: &Connection,
    sql_prefix: &str,
    ids: &[&str],
    mut map: F,
) -> Result<Vec<T>, WorkspaceError>
where
    F: FnMut(&Row<'_>) -> rusqlite::Result<T>,
{
    let mut out = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(ID_CHUNK) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let mut stmt = conn.prepare(&format!("{sql_prefix} IN ({placeholders})"))?;
        let rows = stmt.query_map(params_from_iter(chunk.iter()), &mut map)?;
        for row in rows {
            out.push(row?);
        }
    }
    Ok(out)
}

/// Board hits (rank 0, title only) for `ids`.
fn board_hits(conn: &Connection, ids: &[&str]) -> Result<Vec<SearchHit>, WorkspaceError> {
    query_by_ids(
        conn,
        &format!(
            "SELECT b.id, b.title, b.created_at, {cover}
             FROM boards b
             LEFT JOIN assets ca ON ca.id = b.cover_asset_id
             WHERE b.id",
            cover = asset_columns("ca")
        ),
        ids,
        |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            Ok(SearchHit {
                entity_id: id.clone(),
                kind: "board",
                title: bound_text(&title),
                excerpt: None,
                board_id: id,
                rank: 0,
                thumbnail_asset: asset_at(row, 3)?,
                created_at: row.get(2)?,
            })
        },
    )
}

/// Searches the workspace (Board titles, Note plain text, Link Card title/URL/
/// description, Image caption/file name, File name/preview, Folder alias
/// name/path) and returns a bounded, deterministic result set. This is the V1
/// default: global scope and a title-before-body ordering; both are documented
/// in `docs/specs/search.md` and may be refined after agreement.
pub fn search_workspace(
    conn: &Connection,
    query: &str,
) -> Result<Vec<SearchResultDto>, WorkspaceError> {
    let query = query.trim();
    let Some(expression) = fts_match_expression(query) else {
        return Ok(Vec::new());
    };

    let mut candidates = fts_candidates(conn, &expression)?;
    if candidates.is_empty() && query.chars().count() <= SUBSTRING_FALLBACK_MAX_CHARS {
        candidates = substring_candidates(conn, query)?;
    }

    // Group by kind, keeping the index's order inside each group.
    let mut board_ids: Vec<&str> = Vec::new();
    let mut by_kind: HashMap<CardKind, Vec<SearchCandidate>> = HashMap::new();
    for (entity_id, kind, title_hit) in &candidates {
        if kind == "board" {
            board_ids.push(entity_id);
        } else if let Ok(card_kind) = kind.parse::<CardKind>() {
            by_kind.entry(card_kind).or_default().push(SearchCandidate {
                entity_id: entity_id.clone(),
                title_hit: *title_hit,
            });
        }
    }

    let mut hits = board_hits(conn, &board_ids)?;
    for card_kind in CardKind::ALL {
        if let Some(group) = by_kind.get(card_kind) {
            hits.extend(handler(*card_kind).search_rows(conn, query, group)?);
        }
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
