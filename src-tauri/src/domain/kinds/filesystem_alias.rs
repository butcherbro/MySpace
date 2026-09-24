//! `filesystem_alias` cards: a folder/file shortcut backed by a security-
//! scoped bookmark (`filesystem_aliases`). The projection never exposes the
//! locator bytes; the journal payload carries them as `{"$blob": hex}`.

use rusqlite::{Connection, Row, Transaction};

use super::{card_frame, load_board_rows, load_one_row, DetailTable, AFTER_CARD};
use crate::domain::card_kind::{CardKind, CardKindHandler, CopyContext, SearchHit};
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{CardDto, FilesystemAliasDto};
use crate::repositories::search::{bound_text, contains_query, rank_and_truncate};

pub struct FilesystemAliasHandler;

const DETAIL: DetailTable = DetailTable {
    table: "filesystem_aliases",
    columns: &["target_kind", "locator_blob", "path_hint", "display_name"],
};

const SELECT_FROM: &str =
    "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
        a.target_kind, a.path_hint, a.display_name
 FROM cards c
 JOIN filesystem_aliases a ON a.card_id = c.id";

fn map_row(row: &Row<'_>) -> rusqlite::Result<CardDto> {
    Ok(CardDto::FilesystemAlias(FilesystemAliasDto {
        id: row.get(0)?,
        board_id: row.get(1)?,
        frame: card_frame(row)?,
        z_index: row.get(6)?,
        revision: row.get(7)?,
        target_kind: row.get(AFTER_CARD)?,
        path_hint: row.get(AFTER_CARD + 1)?,
        display_name: row.get(AFTER_CARD + 2)?,
    }))
}

impl CardKindHandler for FilesystemAliasHandler {
    fn kind(&self) -> CardKind {
        CardKind::FilesystemAlias
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

    /// Folder shortcuts match on display name (rank 0) or the display-only
    /// path hint (rank 1, shown as the excerpt); reported as kind `folder`.
    fn search_rows(
        &self,
        conn: &Connection,
        query: &str,
        limit: usize,
    ) -> Result<Vec<SearchHit>, WorkspaceError> {
        let q = query.to_lowercase();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, a.display_name, a.path_hint, c.created_at
             FROM cards c
             JOIN filesystem_aliases a ON a.card_id = c.id
             JOIN boards b ON b.id = c.board_id AND b.deleted_at IS NULL
             WHERE c.deleted_at IS NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;
        let mut hits = Vec::new();
        for row in rows {
            let (id, board_id, display_name, path_hint, created_at) = row?;
            let name_match = contains_query(&display_name, &q);
            let path_match = contains_query(&path_hint, &q);
            if name_match || path_match {
                hits.push(SearchHit {
                    entity_id: id,
                    kind: "folder",
                    title: bound_text(&display_name),
                    excerpt: (!name_match).then(|| bound_text(&path_hint)),
                    board_id,
                    rank: if name_match { 0 } else { 1 },
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
