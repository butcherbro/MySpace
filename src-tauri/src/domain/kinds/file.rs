//! `file` cards: a text-like file copied into the managed asset store, with a
//! bounded inline preview and an optional generated thumbnail (`file_cards`).

use rusqlite::{Connection, Row, Transaction};

use super::{
    asset_at, asset_columns, card_frame, load_board_rows, load_one_row, required_asset_at,
    DetailTable, AFTER_CARD, ASSET_WIDTH, CARD_COLUMNS,
};
use crate::domain::card_kind::{CardKind, CardKindHandler, CopyContext, SearchHit};
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{CardDto, FileCardDto};

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

    /// File cards are not searchable in V1 (docs/specs/search.md).
    fn search_rows(
        &self,
        _conn: &Connection,
        _query: &str,
        _limit: usize,
    ) -> Result<Vec<SearchHit>, WorkspaceError> {
        Ok(Vec::new())
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
