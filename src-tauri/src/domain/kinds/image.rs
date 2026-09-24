//! `image` cards: a static image asset plus an editable caption
//! (`image_cards`).

use rusqlite::{Connection, Row, Transaction};

use super::{
    asset_columns, card_frame, json_at, load_board_rows, load_one_row, required_asset_at,
    DetailTable, AFTER_CARD, ASSET_WIDTH, CARD_COLUMNS,
};
use crate::domain::card_kind::{CardKind, CardKindHandler, CopyContext, SearchHit};
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{CardDto, ImageCardDto};
use crate::repositories::search::{contains_query, rank_and_truncate, search_excerpt};

pub struct ImageHandler;

const DETAIL: DetailTable = DetailTable {
    table: "image_cards",
    columns: &["asset_id", "caption_json", "caption_plain_text"],
};

fn select_from() -> String {
    format!(
        "SELECT {CARD_COLUMNS}, {asset}, i.caption_json, i.caption_plain_text
         FROM cards c
         JOIN image_cards i ON i.card_id = c.id
         JOIN assets a ON a.id = i.asset_id",
        asset = asset_columns("a")
    )
}

fn map_row(row: &Row<'_>) -> rusqlite::Result<CardDto> {
    let caption = AFTER_CARD + ASSET_WIDTH;
    Ok(CardDto::Image(ImageCardDto {
        id: row.get(0)?,
        board_id: row.get(1)?,
        frame: card_frame(row)?,
        z_index: row.get(6)?,
        revision: row.get(7)?,
        asset: required_asset_at(row, AFTER_CARD)?,
        caption_json: json_at(row, caption)?,
        caption_plain_text: row.get(caption + 1)?,
    }))
}

impl CardKindHandler for ImageHandler {
    fn kind(&self) -> CardKind {
        CardKind::Image
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

    /// The copy shares the original's asset row (copy-in model).
    fn copy_detail(
        &self,
        tx: &Transaction,
        from_id: &str,
        to_id: &str,
        _ctx: &CopyContext,
    ) -> Result<(), WorkspaceError> {
        DETAIL.copy(tx, from_id, to_id)
    }

    fn delete_details(&self, tx: &Transaction, ids: &[String]) -> Result<u64, WorkspaceError> {
        DETAIL.delete(tx, ids)
    }

    /// Images match on caption or file name (rank 1); titled by the caption,
    /// else the file name.
    fn search_rows(
        &self,
        conn: &Connection,
        query: &str,
        limit: usize,
    ) -> Result<Vec<SearchHit>, WorkspaceError> {
        let q = query.to_lowercase();
        let mut stmt = conn.prepare(&format!(
            "SELECT c.id, c.board_id, i.caption_plain_text, c.created_at, {asset}
             FROM cards c
             JOIN image_cards i ON i.card_id = c.id
             JOIN assets a ON a.id = i.asset_id
             JOIN boards b ON b.id = c.board_id AND b.deleted_at IS NULL
             WHERE c.deleted_at IS NULL",
            asset = asset_columns("a")
        ))?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                required_asset_at(row, 4)?,
            ))
        })?;
        let mut hits = Vec::new();
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
        rank_and_truncate(&mut hits, limit);
        Ok(hits)
    }

    fn asset_refs(&self) -> &'static [(&'static str, &'static str)] {
        &[("image_cards", "asset_id")]
    }

    fn to_payload(&self, conn: &Connection, id: &str) -> Result<serde_json::Value, WorkspaceError> {
        DETAIL.to_payload(conn, id)
    }

    fn from_payload(
        &self,
        tx: &Transaction,
        id: &str,
        payload: &serde_json::Value,
    ) -> Result<(), WorkspaceError> {
        DETAIL.write_payload(tx, id, payload)
    }
}
