//! `board_shortcut` cards (todo.md №17): a lightweight alias pointing at a
//! board without owning it (`board_shortcut_cards`). Identity is read live
//! through a LEFT JOIN on the target board — never copied — so a shortcut
//! whose target is gone or trashed projects as broken (`target: None`)
//! instead of failing the whole board read.

use rusqlite::{Connection, Row};

use super::{
    asset_at, asset_columns, card_frame, load_board_rows, load_one_row, DetailTable, AFTER_CARD,
    CARD_COLUMNS,
};
use crate::domain::card_kind::{
    CardKind, CardKindHandler, CopyContext, SearchCandidate, SearchHit,
};
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{BoardShortcutDto, BoardShortcutTarget, CardDto};

pub struct BoardShortcutHandler;

const DETAIL: DetailTable = DetailTable {
    table: "board_shortcut_cards",
    columns: &["target_board_id"],
};

fn select_from() -> String {
    format!(
        "SELECT {CARD_COLUMNS},
                s.target_board_id, b.id, b.revision, b.title, b.color_token, b.symbol, b.deleted_at,
                {cover}
         FROM cards c
         JOIN board_shortcut_cards s ON s.card_id = c.id
         LEFT JOIN boards b ON b.id = s.target_board_id
         LEFT JOIN assets ca ON ca.id = b.cover_asset_id",
        cover = asset_columns("ca"),
    )
}

fn map_row(row: &Row<'_>) -> rusqlite::Result<CardDto> {
    let s = AFTER_CARD;
    let target_board_id: String = row.get(s)?;
    let board_alive: Option<String> = row.get(s + 1)?;
    let board_deleted_at: Option<i64> = row.get(s + 6)?;
    let target = if board_alive.is_some() && board_deleted_at.is_none() {
        Some(BoardShortcutTarget {
            id: target_board_id.clone(),
            board_revision: row.get(s + 2)?,
            title: row.get(s + 3)?,
            color_token: row.get(s + 4)?,
            symbol: row.get(s + 5)?,
            cover_asset: asset_at(row, s + 7)?,
        })
    } else {
        None
    };
    Ok(CardDto::BoardShortcut(BoardShortcutDto {
        id: row.get(0)?,
        board_id: row.get(1)?,
        frame: card_frame(row)?,
        z_index: row.get(6)?,
        revision: row.get(7)?,
        target_board_id,
        target,
    }))
}

impl CardKindHandler for BoardShortcutHandler {
    fn kind(&self) -> CardKind {
        CardKind::BoardShortcut
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

    /// A shortcut's copy points at the SAME target board as the original — it
    /// is never remapped to a duplicated descendant, even when the target is
    /// inside the duplicated subtree (docs/decisions/0010-board-shortcuts.md).
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

    /// Shortcuts have no text of their own; the target board is found by its
    /// own title.
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
