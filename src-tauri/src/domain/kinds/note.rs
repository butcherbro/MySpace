//! `note` cards: a rich-text document plus its plain-text projection and a
//! background color preset (`note_cards`).

use rusqlite::{Connection, Row, Transaction};

use super::{card_frame, json_at, load_board_rows, load_one_row, DetailTable, AFTER_CARD};
use crate::domain::card_kind::{CardKind, CardKindHandler, CopyContext, SearchHit};
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{CardDto, NoteCardDto};
use crate::repositories::search::{contains_query, rank_and_truncate, search_excerpt};

pub struct NoteHandler;

const DETAIL: DetailTable = DetailTable {
    table: "note_cards",
    columns: &["document_json", "plain_text", "color_token"],
};

const SELECT_FROM: &str =
    "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
        n.document_json, n.plain_text, n.color_token
 FROM cards c
 JOIN note_cards n ON n.card_id = c.id";

fn map_row(row: &Row<'_>) -> rusqlite::Result<CardDto> {
    Ok(CardDto::Note(NoteCardDto {
        id: row.get(0)?,
        board_id: row.get(1)?,
        frame: card_frame(row)?,
        z_index: row.get(6)?,
        revision: row.get(7)?,
        document_json: json_at(row, AFTER_CARD)?,
        plain_text: row.get(AFTER_CARD + 1)?,
        color_token: row.get(AFTER_CARD + 2)?,
    }))
}

impl CardKindHandler for NoteHandler {
    fn kind(&self) -> CardKind {
        CardKind::Note
    }

    fn load_many(
        &self,
        conn: &Connection,
        board_id: &str,
        unsorted: bool,
    ) -> Result<Vec<CardDto>, WorkspaceError> {
        load_board_rows(conn, SELECT_FROM, board_id, unsorted, map_row)
    }

    fn load_one(&self, conn: &Connection, id: &str) -> Result<Option<CardDto>, WorkspaceError> {
        load_one_row(conn, SELECT_FROM, id, map_row)
    }

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

    /// Notes match on their plain text (rank 1, body level).
    fn search_rows(
        &self,
        conn: &Connection,
        query: &str,
        limit: usize,
    ) -> Result<Vec<SearchHit>, WorkspaceError> {
        let q = query.to_lowercase();
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
        let mut hits = Vec::new();
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
        rank_and_truncate(&mut hits, limit);
        Ok(hits)
    }

    fn asset_refs(&self) -> &'static [(&'static str, &'static str)] {
        &[]
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
