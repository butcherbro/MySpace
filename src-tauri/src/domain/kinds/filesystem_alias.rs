//! `filesystem_alias` cards: a folder/file shortcut backed by a security-
//! scoped bookmark (`filesystem_aliases`). The projection never exposes the
//! locator bytes; the journal payload carries them as `{"$blob": hex}`.

use std::collections::HashMap;

use rusqlite::{Connection, Row, Transaction};

use super::{card_frame, load_board_rows, load_one_row, DetailTable, AFTER_CARD};
use crate::domain::card_kind::{
    CardKind, CardKindHandler, CopyContext, SearchCandidate, SearchHit,
};
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{CardDto, FilesystemAliasDto};
use crate::repositories::search::{bound_text, query_by_ids};

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
        _query: &str,
        candidates: &[SearchCandidate],
    ) -> Result<Vec<SearchHit>, WorkspaceError> {
        let title_hits: HashMap<&str, bool> = candidates
            .iter()
            .map(|c| (c.entity_id.as_str(), c.title_hit))
            .collect();
        let ids: Vec<&str> = title_hits.keys().copied().collect();
        query_by_ids(
            conn,
            "SELECT c.id, c.board_id, a.display_name, a.path_hint, c.created_at
             FROM cards c
             JOIN filesystem_aliases a ON a.card_id = c.id
             WHERE c.id",
            &ids,
            |row| {
                let id: String = row.get(0)?;
                let display_name: String = row.get(2)?;
                let path_hint: String = row.get(3)?;
                let name_match = title_hits.get(id.as_str()).copied().unwrap_or(false);
                Ok(SearchHit {
                    entity_id: id,
                    kind: "folder",
                    title: bound_text(&display_name),
                    excerpt: (!name_match).then(|| bound_text(&path_hint)),
                    board_id: row.get(1)?,
                    rank: if name_match { 0 } else { 1 },
                    thumbnail_asset: None,
                    created_at: row.get(4)?,
                })
            },
        )
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
