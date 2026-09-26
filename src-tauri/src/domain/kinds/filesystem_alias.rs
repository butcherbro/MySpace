//! `filesystem_alias` cards: a folder/file shortcut (`filesystem_aliases`).
//!
//! Device scope (ADR-0012): the detail row (target kind, path hint, display
//! name, origin device) is board content and is what the journal payload
//! carries. The locators that make a shortcut open live in
//! `filesystem_alias_locators`, one per (card, device); they are local-only,
//! never part of the payload, and never exposed by the projection. The
//! projection reports `local` (this device holds a locator) instead.

use std::collections::HashMap;

use rusqlite::{Connection, Row};

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
    columns: &[
        "target_kind",
        "path_hint",
        "display_name",
        "origin_device_id",
    ],
};

const SELECT_FROM: &str =
    "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
        a.target_kind, a.path_hint, a.display_name, COALESCE(a.origin_device_id, ''), d.name,
        EXISTS (
            SELECT 1 FROM filesystem_alias_locators l
            WHERE l.card_id = c.id
              AND l.device_id = (SELECT value FROM local_meta WHERE key = 'device_id')
        )
 FROM cards c
 JOIN filesystem_aliases a ON a.card_id = c.id
 LEFT JOIN known_devices d ON d.device_id = a.origin_device_id";

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
        origin_device_id: row.get(AFTER_CARD + 3)?,
        origin_device_name: row.get(AFTER_CARD + 4)?,
        local: row.get(AFTER_CARD + 5)?,
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
        tx: &Connection,
        from_id: &str,
        to_id: &str,
        _ctx: &CopyContext,
    ) -> Result<(), WorkspaceError> {
        DETAIL.copy(tx, from_id, to_id)?;
        // A duplicate opens wherever the original did: copy the locators this
        // database holds (they stay local; the new card row already exists).
        tx.execute(
            "INSERT OR IGNORE INTO filesystem_alias_locators (card_id, device_id, locator_blob)
             SELECT ?2, device_id, locator_blob FROM filesystem_alias_locators WHERE card_id = ?1",
            rusqlite::params![from_id, to_id],
        )?;
        Ok(())
    }

    /// Deletes the detail rows only. Locators are tied to the `cards` row
    /// (`ON DELETE CASCADE`, migration 0024), so they go when the card is
    /// hard-deleted, and survive a journal codec drop/re-apply of this row.
    fn delete_details(&self, tx: &Connection, ids: &[String]) -> Result<u64, WorkspaceError> {
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
        tx: &Connection,
        id: &str,
        payload: &serde_json::Value,
    ) -> Result<(), WorkspaceError> {
        DETAIL.write_payload(tx, id, payload)
    }
}
