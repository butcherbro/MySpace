//! `file` cards: a text-like file copied into the managed asset store, with a
//! bounded inline preview and an optional generated thumbnail (`file_cards`).

use std::collections::HashMap;

use rusqlite::{Connection, Row, Transaction};

use super::{
    asset_at, asset_columns, card_frame, load_board_rows, load_one_row, required_asset_at,
    DetailTable, AFTER_CARD, ASSET_WIDTH, CARD_COLUMNS,
};
use crate::domain::card_kind::{
    CardKind, CardKindHandler, CopyContext, SearchCandidate, SearchHit,
};
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{CardDto, FileCardDto};
use crate::repositories::search::{bound_text, query_by_ids, search_excerpt};

pub struct FileHandler;

const DETAIL: DetailTable = DetailTable {
    table: "file_cards",
    columns: &[
        "asset_id",
        "mime_type",
        "preview_text",
        "source_path",
        "preview_asset_id",
    ],
};

const PREVIEW_TEXT: usize = AFTER_CARD + ASSET_WIDTH;

fn select_from() -> String {
    format!(
        "SELECT {CARD_COLUMNS}, {asset}, f.preview_text, {preview}
         FROM cards c
         JOIN file_cards f ON f.card_id = c.id
         JOIN assets a ON a.id = f.asset_id
         LEFT JOIN assets pa ON pa.id = f.preview_asset_id",
        asset = asset_columns("a"),
        preview = asset_columns("pa"),
    )
}

fn map_row(row: &Row<'_>) -> rusqlite::Result<CardDto> {
    Ok(CardDto::File(FileCardDto {
        id: row.get(0)?,
        board_id: row.get(1)?,
        frame: card_frame(row)?,
        z_index: row.get(6)?,
        revision: row.get(7)?,
        asset: required_asset_at(row, AFTER_CARD)?,
        preview_text: row.get(PREVIEW_TEXT)?,
        preview_asset: asset_at(row, PREVIEW_TEXT + 1)?,
    }))
}

impl CardKindHandler for FileHandler {
    fn kind(&self) -> CardKind {
        CardKind::File
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

    /// The copy shares the original's file and thumbnail asset rows.
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

    /// File cards match by file name (title level) and preview text.
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
        query_by_ids(
            conn,
            &format!(
                "SELECT c.id, c.board_id, a.file_name, f.preview_text, c.created_at, {preview}
                 FROM cards c
                 JOIN file_cards f ON f.card_id = c.id
                 JOIN assets a ON a.id = f.asset_id
                 LEFT JOIN assets pa ON pa.id = f.preview_asset_id
                 WHERE c.id",
                preview = asset_columns("pa"),
            ),
            &ids,
            |row| {
                let id: String = row.get(0)?;
                let file_name: String = row.get(2)?;
                let preview_text: String = row.get(3)?;
                let name_match = title_hits.get(id.as_str()).copied().unwrap_or(false);
                Ok(SearchHit {
                    entity_id: id,
                    kind: "file",
                    title: bound_text(&file_name),
                    excerpt: (!name_match).then(|| search_excerpt(&preview_text, query)),
                    board_id: row.get(1)?,
                    rank: if name_match { 0 } else { 1 },
                    thumbnail_asset: asset_at(row, 5)?,
                    created_at: row.get(4)?,
                })
            },
        )
    }

    fn asset_refs(&self) -> &'static [(&'static str, &'static str)] {
        &[
            ("file_cards", "asset_id"),
            ("file_cards", "preview_asset_id"),
        ]
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
