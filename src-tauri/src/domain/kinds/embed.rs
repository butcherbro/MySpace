//! `embed` (Link) cards: a URL with optional fetched/custom preview and
//! favicon assets and a versioned rich-text description (`embed_cards`).

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, Row};

use super::{
    asset_at, asset_columns, card_frame, document_at, load_board_rows, load_one_row, DetailTable,
    AFTER_CARD, ASSET_WIDTH, CARD_COLUMNS,
};
use crate::domain::card_kind::{
    CardKind, CardKindHandler, CopyContext, SearchCandidate, SearchHit,
};
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{CardDto, EmbedCardDto};
use crate::repositories::search::{query_by_ids, search_excerpt};

pub struct EmbedHandler;

const DETAIL: DetailTable = DetailTable {
    table: "embed_cards",
    columns: &[
        "source_url",
        "display_url",
        "site_name",
        "title",
        "provider",
        "description_json",
        "description_plain_text",
        "description_origin",
        "asset_id",
        "favicon_asset_id",
        "preview_origin",
        "metadata_status",
        "metadata_error",
    ],
};

/// Index of the preview asset block; the favicon block follows it.
const PREVIEW: usize = AFTER_CARD + 11;
const FAVICON: usize = PREVIEW + ASSET_WIDTH;

fn select_from() -> String {
    format!(
        "SELECT {CARD_COLUMNS},
                e.source_url, e.display_url, e.site_name, e.title, e.provider,
                e.description_json, e.description_plain_text, e.description_origin,
                e.preview_origin, e.metadata_status, e.metadata_error,
                {preview}, {favicon}
         FROM cards c
         JOIN embed_cards e ON e.card_id = c.id
         LEFT JOIN assets pa ON pa.id = e.asset_id
         LEFT JOIN assets fa ON fa.id = e.favicon_asset_id",
        preview = asset_columns("pa"),
        favicon = asset_columns("fa"),
    )
}

fn map_embed(row: &Row<'_>) -> rusqlite::Result<EmbedCardDto> {
    let e = AFTER_CARD;
    let description = document_at(row, e + 5)?;
    Ok(EmbedCardDto {
        id: row.get(0)?,
        board_id: row.get(1)?,
        frame: card_frame(row)?,
        z_index: row.get(6)?,
        revision: row.get(7)?,
        source_url: row.get(e)?,
        display_url: row.get(e + 1)?,
        site_name: row.get(e + 2)?,
        title: row.get::<_, Option<String>>(e + 3)?.unwrap_or_default(),
        provider: row.get(e + 4)?,
        description_json: description.json,
        description_plain_text: row.get(e + 6)?,
        description_origin: row.get(e + 7)?,
        preview_origin: row.get(e + 8)?,
        metadata_status: row.get(e + 9)?,
        metadata_error: row.get(e + 10)?,
        preview_asset: asset_at(row, PREVIEW)?,
        favicon_asset: asset_at(row, FAVICON)?,
        corrupt: description.corrupt,
    })
}

fn map_row(row: &Row<'_>) -> rusqlite::Result<CardDto> {
    Ok(CardDto::Embed(Box::new(map_embed(row)?)))
}

/// One live embed card as its own DTO (used by the convert/enrich paths that
/// return the authoritative embed projection).
pub fn load_embed(conn: &Connection, id: &str) -> Result<Option<EmbedCardDto>, WorkspaceError> {
    conn.query_row(
        &format!("{} WHERE c.id = ?1 AND c.deleted_at IS NULL", select_from()),
        [id],
        map_embed,
    )
    .optional()
    .map_err(WorkspaceError::from)
}

impl CardKindHandler for EmbedHandler {
    fn kind(&self) -> CardKind {
        CardKind::Embed
    }

    fn load_many(
        &self,
        conn: &Connection,
        board_id: &str,
        unsorted: bool,
    ) -> Result<Vec<CardDto>, WorkspaceError> {
        load_board_rows(conn, &select_from(), board_id, unsorted, map_row)
    }

    fn load_one(&self, conn: &Connection, id: &str) -> Result<Option<CardDto>, WorkspaceError> {
        load_one_row(conn, &select_from(), id, map_row)
    }

    /// The copy shares the original's preview/favicon asset rows.
    fn copy_detail(
        &self,
        tx: &Connection,
        from_id: &str,
        to_id: &str,
        _ctx: &CopyContext,
    ) -> Result<(), WorkspaceError> {
        DETAIL.copy(tx, from_id, to_id)
    }

    fn delete_details(&self, tx: &Connection, ids: &[String]) -> Result<u64, WorkspaceError> {
        DETAIL.delete(tx, ids)
    }

    /// Link cards match on title/URL (rank 0) or description (rank 2, with an
    /// excerpt); reported to the UI as kind `link`.
    fn search_rows(
        &self,
        conn: &Connection,
        query: &str,
        candidates: &[SearchCandidate],
    ) -> Result<Vec<SearchHit>, WorkspaceError> {
        let title_hits: HashMap<&str, bool> = candidates
            .iter()
            .map(|c| (c.entity_id.as_str(), c.title_hit))
            .collect();
        let ids: Vec<&str> = title_hits.keys().copied().collect();
        let preview = 6;
        let favicon = preview + ASSET_WIDTH;
        query_by_ids(
            conn,
            &format!(
                "SELECT c.id, c.board_id, e.title, e.source_url, e.description_plain_text,
                        c.created_at, {preview_cols}, {favicon_cols}
                 FROM cards c
                 JOIN embed_cards e ON e.card_id = c.id
                 LEFT JOIN assets pa ON pa.id = e.asset_id
                 LEFT JOIN assets fa ON fa.id = e.favicon_asset_id
                 WHERE c.id",
                preview_cols = asset_columns("pa"),
                favicon_cols = asset_columns("fa"),
            ),
            &ids,
            |row| {
                let id: String = row.get(0)?;
                let title_raw: Option<String> = row.get(2)?;
                let source_url: String = row.get(3)?;
                let description: String = row.get(4)?;
                let title = title_raw
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or(source_url);
                // Title, source URL and display URL are the title-level text.
                let (rank, excerpt) = if title_hits.get(id.as_str()).copied().unwrap_or(false) {
                    (0, None)
                } else {
                    (2, Some(search_excerpt(&description, query)))
                };
                Ok(SearchHit {
                    entity_id: id,
                    kind: "link",
                    title,
                    excerpt,
                    board_id: row.get(1)?,
                    rank,
                    thumbnail_asset: asset_at(row, preview)?.or(asset_at(row, favicon)?),
                    created_at: row.get(5)?,
                })
            },
        )
    }

    fn asset_refs(&self) -> &'static [(&'static str, &'static str)] {
        &[
            ("embed_cards", "asset_id"),
            ("embed_cards", "favicon_asset_id"),
        ]
    }

    fn to_payload(&self, conn: &Connection, id: &str) -> Result<serde_json::Value, WorkspaceError> {
        DETAIL.to_payload(conn, id)
    }

    fn from_payload(
        &self,
        tx: &Connection,
        id: &str,
        payload: &serde_json::Value,
    ) -> Result<(), WorkspaceError> {
        DETAIL.write_payload(tx, id, payload)
    }
}
