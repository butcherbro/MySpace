//! `group` cards (ADR-0013): a named, coloured frame under other cards
//! (`group_cards`). The group owns nothing: membership is stored on the
//! member (`cards.group_id`, migration 0029), so the detail row is just
//! title and colour.

use rusqlite::{Connection, Row};

use super::{
    card_created_at, card_frame, card_group_id, load_board_rows, load_one_row, DetailTable,
    AFTER_CARD, CARD_COLUMNS,
};
use crate::domain::card_kind::{
    CardKind, CardKindHandler, CopyContext, SearchCandidate, SearchHit,
};
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{CardDto, GroupCardDto};

pub struct GroupHandler;

const DETAIL: DetailTable = DetailTable {
    table: "group_cards",
    columns: &["title", "color_token"],
};

fn select_from() -> String {
    format!(
        "SELECT {CARD_COLUMNS}, g.title, g.color_token
         FROM cards c
         JOIN group_cards g ON g.card_id = c.id"
    )
}

fn map_row(row: &Row<'_>) -> rusqlite::Result<CardDto> {
    Ok(CardDto::Group(GroupCardDto {
        id: row.get(0)?,
        board_id: row.get(1)?,
        frame: card_frame(row)?,
        z_index: row.get(6)?,
        revision: row.get(7)?,
        group_id: card_group_id(row)?,
        created_at: card_created_at(row)?,
        title: row.get(AFTER_CARD)?,
        color_token: row.get(AFTER_CARD + 1)?,
    }))
}

impl CardKindHandler for GroupHandler {
    fn kind(&self) -> CardKind {
        CardKind::Group
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

    /// Not searchable in v1 (ADR-0013): the title joins FTS in a follow-up.
    fn search_rows(
        &self,
        _conn: &Connection,
        _query: &str,
        _candidates: &[SearchCandidate],
    ) -> Result<Vec<SearchHit>, WorkspaceError> {
        Ok(Vec::new())
    }

    fn asset_refs(&self) -> &'static [(&'static str, &'static str)] {
        &[]
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
