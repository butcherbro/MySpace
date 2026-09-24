//! `board_portal` cards: a board's primary portal on its parent board
//! (`board_portal_cards`). The target board's identity and subtree counts are
//! read live; duplicating a portal duplicates its whole target subtree.

use rusqlite::{params, Connection, Row, Transaction};

use super::{
    asset_at, asset_columns, card_frame, load_board_rows, load_one_row, DetailTable, AFTER_CARD,
    CARD_COLUMNS,
};
use crate::domain::card_kind::{
    CardKind, CardKindHandler, CopyContext, SearchCandidate, SearchHit,
};
use crate::domain::duplicate_board;
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{BoardPortalDto, CardDto, PortalTarget};

pub struct BoardPortalHandler;

const DETAIL: DetailTable = DetailTable {
    table: "board_portal_cards",
    columns: &["target_board_id"],
};

/// Child counts are aggregated per portal via correlated subqueries (no N+1).
/// Without counts (the Unsorted panel) both columns are a constant 0.
fn select_from(with_counts: bool) -> String {
    let counts = if with_counts {
        "(SELECT COUNT(*) FROM boards cb
          WHERE cb.parent_board_id = p.target_board_id AND cb.deleted_at IS NULL),
         (SELECT COUNT(*) FROM cards cc
          WHERE cc.board_id = p.target_board_id AND cc.deleted_at IS NULL)"
    } else {
        "0, 0"
    };
    format!(
        "SELECT {CARD_COLUMNS},
                p.target_board_id, b.revision, b.title, b.color_token, b.symbol,
                {counts},
                {cover}
         FROM cards c
         JOIN board_portal_cards p ON p.card_id = c.id
         JOIN boards b ON b.id = p.target_board_id
         LEFT JOIN assets ca ON ca.id = b.cover_asset_id",
        cover = asset_columns("ca"),
    )
}

fn map_portal(row: &Row<'_>) -> rusqlite::Result<BoardPortalDto> {
    let p = AFTER_CARD;
    Ok(BoardPortalDto {
        id: row.get(0)?,
        board_id: row.get(1)?,
        frame: card_frame(row)?,
        z_index: row.get(6)?,
        revision: row.get(7)?,
        target: PortalTarget {
            id: row.get(p)?,
            board_revision: row.get(p + 1)?,
            title: row.get(p + 2)?,
            color_token: row.get(p + 3)?,
            symbol: row.get(p + 4)?,
            child_board_count: row.get(p + 5)?,
            child_card_count: row.get(p + 6)?,
            cover_asset: asset_at(row, p + 7)?,
        },
    })
}

fn map_row(row: &Row<'_>) -> rusqlite::Result<CardDto> {
    Ok(CardDto::BoardPortal(map_portal(row)?))
}

/// One portal card by id, trashed or not, with live counts. Used by
/// `duplicate_board` to return the freshly-created portal.
pub fn load_portal(conn: &Connection, id: &str) -> Result<BoardPortalDto, WorkspaceError> {
    conn.query_row(
        &format!("{} WHERE c.id = ?1", select_from(true)),
        [id],
        map_portal,
    )
    .map_err(WorkspaceError::from)
}

impl CardKindHandler for BoardPortalHandler {
    fn kind(&self) -> CardKind {
        CardKind::BoardPortal
    }

    /// Canvas portals carry subtree counts; Unsorted thumbnails do not.
    fn load_many(
        &self,
        conn: &Connection,
        board_id: &str,
        unsorted: bool,
    ) -> Result<Vec<CardDto>, WorkspaceError> {
        load_board_rows(conn, &select_from(!unsorted), board_id, unsorted, map_row)
    }

    fn load_one(&self, conn: &Connection, id: &str) -> Result<Option<CardDto>, WorkspaceError> {
        load_one_row(conn, &select_from(true), id, map_row)
    }

    /// A nested portal: recursively duplicate its own target board under the
    /// new board, then point the copied portal card at that copy.
    fn copy_detail(
        &self,
        tx: &Transaction,
        from_id: &str,
        to_id: &str,
        ctx: &CopyContext,
    ) -> Result<(), WorkspaceError> {
        let nested_target_board_id: String = tx.query_row(
            "SELECT target_board_id FROM board_portal_cards WHERE card_id = ?1",
            [from_id],
            |r| r.get(0),
        )?;
        let (nested_title, nested_color, nested_symbol, nested_cover): (
            String,
            String,
            Option<String>,
            Option<String>,
        ) = tx.query_row(
            "SELECT title, color_token, symbol, cover_asset_id FROM boards WHERE id = ?1",
            [nested_target_board_id.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        let nested_new_board_id = uuid::Uuid::now_v7().to_string();
        duplicate_board::copy_board_subtree(
            tx,
            &nested_target_board_id,
            &nested_new_board_id,
            ctx.workspace_id,
            ctx.new_board_id,
            &nested_title,
            &nested_color,
            nested_symbol.as_deref(),
            nested_cover.as_deref(),
            ctx.now,
            ctx.depth + 1,
        )?;
        tx.execute(
            "INSERT INTO board_portal_cards (card_id, target_board_id) VALUES (?1, ?2)",
            params![to_id, nested_new_board_id],
        )?;
        Ok(())
    }

    fn delete_details(&self, tx: &Transaction, ids: &[String]) -> Result<u64, WorkspaceError> {
        DETAIL.delete(tx, ids)
    }

    /// Boards are searched by title in `search_workspace` itself; the portal
    /// card adds nothing searchable.
    fn search_rows(
        &self,
        _conn: &Connection,
        _query: &str,
        _candidates: &[SearchCandidate],
    ) -> Result<Vec<SearchHit>, WorkspaceError> {
        Ok(Vec::new())
    }

    /// The cover image belongs to the board (`boards.cover_asset_id`), not to
    /// the portal card.
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
