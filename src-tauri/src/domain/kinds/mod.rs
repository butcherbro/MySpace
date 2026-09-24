//! One [`CardKindHandler`] per card kind, plus the pieces they share: the
//! `cards` column prefix and its frame reader, the asset column block, and
//! [`DetailTable`], the generic copy/delete/journal codec over a kind's
//! detail table. See `domain::card_kind` for the contract.

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};

use crate::domain::card_kind::{CardKind, CardKindHandler};
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{AssetDto, CardDto, Frame};

pub mod board_portal;
pub mod board_shortcut;
pub mod embed;
pub mod file;
pub mod filesystem_alias;
pub mod image;
pub mod note;

/// The registry, in [`CardKind::ALL`] order (checked by a test).
static REGISTRY: [&dyn CardKindHandler; 7] = [
    &note::NoteHandler,
    &board_portal::BoardPortalHandler,
    &image::ImageHandler,
    &embed::EmbedHandler,
    &filesystem_alias::FilesystemAliasHandler,
    &file::FileHandler,
    &board_shortcut::BoardShortcutHandler,
];

/// Every registered handler, in [`CardKind::ALL`] order.
pub fn registry() -> &'static [&'static dyn CardKindHandler] {
    &REGISTRY
}

/// The handler for `kind`. Every kind is registered, so this never fails.
pub fn handler(kind: CardKind) -> &'static dyn CardKindHandler {
    match REGISTRY.iter().find(|h| h.kind() == kind) {
        Some(h) => *h,
        None => unreachable!("card kind {kind} has no registered handler"),
    }
}

/// The eight `cards` columns every projection starts with (indices 0..=7);
/// read back by [`card_frame`] and the `id/board_id/z_index/revision` getters.
pub(crate) const CARD_COLUMNS: &str =
    "c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision";

/// Index of the first column after [`CARD_COLUMNS`].
pub(crate) const AFTER_CARD: usize = 8;

/// Row filter for a board's cards (`?1` board id, `?2` unsorted flag).
const BOARD_FILTER: &str =
    "WHERE c.board_id = ?1 AND c.deleted_at IS NULL AND c.unsorted = ?2 ORDER BY c.z_index, c.id";

/// Row filter for one live card (`?1` card id).
const ONE_FILTER: &str = "WHERE c.id = ?1 AND c.deleted_at IS NULL";

/// The frame stored in [`CARD_COLUMNS`] positions 2..=5.
pub(crate) fn card_frame(row: &Row<'_>) -> rusqlite::Result<Frame> {
    Ok(Frame {
        x: row.get(2)?,
        y: row.get(3)?,
        width: row.get(4)?,
        height: row.get(5)?,
    })
}

/// Eight asset columns for the joined `assets` alias, in the order
/// [`asset_at`] reads them.
pub(crate) fn asset_columns(alias: &str) -> String {
    format!(
        "{a}.id, {a}.file_name, {a}.mime_type, {a}.width, {a}.height, {a}.size_bytes, {a}.file_path, {a}.sha256",
        a = alias
    )
}

/// Number of columns produced by [`asset_columns`].
pub(crate) const ASSET_WIDTH: usize = 8;

/// The asset whose [`asset_columns`] block starts at `first`, or `None` when
/// the (LEFT JOINed) asset id is NULL.
pub(crate) fn asset_at(row: &Row<'_>, first: usize) -> rusqlite::Result<Option<AssetDto>> {
    let Some(id) = row.get::<_, Option<String>>(first)? else {
        return Ok(None);
    };
    Ok(Some(AssetDto {
        id,
        file_name: row.get(first + 1)?,
        mime_type: row.get(first + 2)?,
        width: row.get(first + 3)?,
        height: row.get(first + 4)?,
        size_bytes: row.get(first + 5)?,
        file_path: row.get(first + 6)?,
        sha256: row.get(first + 7)?,
    }))
}

/// Like [`asset_at`] for an inner-joined (mandatory) asset.
pub(crate) fn required_asset_at(row: &Row<'_>, first: usize) -> rusqlite::Result<AssetDto> {
    asset_at(row, first)?.ok_or(rusqlite::Error::InvalidColumnType(
        first,
        "asset id".into(),
        rusqlite::types::Type::Null,
    ))
}

/// The document a corrupt column is projected as: an empty Tiptap doc.
pub fn empty_document() -> serde_json::Value {
    serde_json::json!({ "type": "doc", "content": [] })
}

/// Parses a stored rich-text document column. Blank text (the legacy
/// `DEFAULT ''` of `embed_cards.description_json`) is "no document" and
/// becomes `null`; any other unparsable text is corrupt (`None`).
pub fn parse_stored_document(text: &str) -> Option<serde_json::Value> {
    if text.trim().is_empty() {
        return Some(serde_json::Value::Null);
    }
    serde_json::from_str(text).ok()
}

/// True when a stored document column holds corrupt (unparsable) text.
pub fn is_corrupt_document(text: &str) -> bool {
    parse_stored_document(text).is_none()
}

/// A stored document read back with its corruption flag (P1.7).
pub(crate) struct StoredDocument {
    pub json: serde_json::Value,
    pub corrupt: bool,
}

/// A JSON document column of the card whose id is column 0. Corrupt text
/// never fails the load: it becomes [`empty_document`] with `corrupt: true`
/// and is logged (card id and error code only, never content).
pub(crate) fn document_at(row: &Row<'_>, index: usize) -> rusqlite::Result<StoredDocument> {
    let text: String = row.get(index)?;
    Ok(match parse_stored_document(&text) {
        Some(json) => StoredDocument {
            json,
            corrupt: false,
        },
        None => {
            let card_id: String = row.get(0)?;
            tracing::warn!(
                card_id = %card_id,
                error_code = "corrupt_document",
                "stored document is not valid JSON; projecting an empty doc"
            );
            StoredDocument {
                json: empty_document(),
                corrupt: true,
            }
        }
    })
}

/// Runs `select_from` (a `SELECT … FROM cards c JOIN …` without WHERE) for
/// a board's canvas or Unsorted cards and maps each row.
pub(crate) fn load_board_rows<F>(
    conn: &Connection,
    select_from: &str,
    board_id: &str,
    unsorted: bool,
    map: F,
) -> Result<Vec<CardDto>, WorkspaceError>
where
    F: FnMut(&Row<'_>) -> rusqlite::Result<CardDto>,
{
    let mut stmt = conn.prepare(&format!("{select_from} {BOARD_FILTER}"))?;
    let rows = stmt.query_map(params![board_id, i64::from(unsorted)], map)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(WorkspaceError::from)
}

/// Runs `select_from` for one live card id and maps the row, if any.
pub(crate) fn load_one_row<F>(
    conn: &Connection,
    select_from: &str,
    id: &str,
    map: F,
) -> Result<Option<CardDto>, WorkspaceError>
where
    F: FnOnce(&Row<'_>) -> rusqlite::Result<CardDto>,
{
    conn.query_row(&format!("{select_from} {ONE_FILTER}"), [id], map)
        .optional()
        .map_err(WorkspaceError::from)
}

/// SQLite's default bound-parameter limit is 999 on old builds; stay well
/// under it when expanding `IN (?, ?, …)`.
const DELETE_CHUNK: usize = 500;

/// A kind's detail table: `card_id` primary key plus `columns`. Gives every
/// handler the same lossless copy, delete and journal codec.
pub(crate) struct DetailTable {
    pub table: &'static str,
    /// Every column except `card_id`, in payload order.
    pub columns: &'static [&'static str],
}

impl DetailTable {
    /// Copies `from_id`'s row to `to_id` verbatim.
    pub fn copy(&self, tx: &Connection, from_id: &str, to_id: &str) -> Result<(), WorkspaceError> {
        let columns = self.columns.join(", ");
        let copied = tx.execute(
            &format!(
                "INSERT INTO {table} (card_id, {columns}) SELECT ?2, {columns} FROM {table} WHERE card_id = ?1",
                table = self.table
            ),
            params![from_id, to_id],
        )?;
        if copied == 0 {
            return Err(WorkspaceError::Database(format!(
                "card {from_id} has no {} row",
                self.table
            )));
        }
        Ok(())
    }

    /// Deletes the rows of `ids`, in bounded chunks.
    pub fn delete(&self, tx: &Connection, ids: &[String]) -> Result<u64, WorkspaceError> {
        let mut deleted = 0u64;
        for chunk in ids.chunks(DELETE_CHUNK) {
            let placeholders = vec!["?"; chunk.len()].join(", ");
            deleted += tx.execute(
                &format!(
                    "DELETE FROM {} WHERE card_id IN ({placeholders})",
                    self.table
                ),
                params_from_iter(chunk.iter()),
            )? as u64;
        }
        Ok(deleted)
    }

    /// The row as a JSON object keyed by column name. Integers, reals, text
    /// and NULL map to their JSON counterparts; a BLOB becomes
    /// `{"$blob": "<lowercase hex>"}`.
    pub fn to_payload(
        &self,
        conn: &Connection,
        id: &str,
    ) -> Result<serde_json::Value, WorkspaceError> {
        let sql = format!(
            "SELECT {} FROM {} WHERE card_id = ?1",
            self.columns.join(", "),
            self.table
        );
        let object = conn
            .query_row(&sql, [id], |row| {
                let mut object = serde_json::Map::new();
                for (index, column) in self.columns.iter().enumerate() {
                    object.insert((*column).to_string(), sql_to_json(row.get_ref(index)?));
                }
                Ok(object)
            })
            .optional()?
            .ok_or_else(|| WorkspaceError::NotFound(id.to_string()))?;
        Ok(serde_json::Value::Object(object))
    }

    /// Inserts or replaces card `id`'s row from a [`DetailTable::to_payload`]
    /// object. Every column must be present (`null` is a value).
    pub fn write_payload(
        &self,
        tx: &Connection,
        id: &str,
        payload: &serde_json::Value,
    ) -> Result<(), WorkspaceError> {
        let object = payload.as_object().ok_or_else(|| {
            WorkspaceError::ConstraintViolation(format!("{} payload must be an object", self.table))
        })?;
        let mut values = Vec::with_capacity(self.columns.len() + 1);
        values.push(SqlValue::Text(id.to_string()));
        for column in self.columns {
            let value = object.get(*column).ok_or_else(|| {
                WorkspaceError::ConstraintViolation(format!(
                    "{} payload is missing `{column}`",
                    self.table
                ))
            })?;
            values.push(json_to_sql(self.table, column, value)?);
        }
        let placeholders = vec!["?"; values.len()].join(", ");
        tx.execute(
            &format!(
                "INSERT OR REPLACE INTO {} (card_id, {}) VALUES ({placeholders})",
                self.table,
                self.columns.join(", ")
            ),
            params_from_iter(values.iter()),
        )?;
        Ok(())
    }
}

fn sql_to_json(value: ValueRef<'_>) -> serde_json::Value {
    match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(i) => serde_json::Value::from(i),
        ValueRef::Real(f) => serde_json::Value::from(f),
        ValueRef::Text(bytes) => {
            serde_json::Value::String(String::from_utf8_lossy(bytes).into_owned())
        }
        ValueRef::Blob(bytes) => {
            let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            serde_json::json!({ "$blob": hex })
        }
    }
}

fn json_to_sql(
    table: &str,
    column: &str,
    value: &serde_json::Value,
) -> Result<SqlValue, WorkspaceError> {
    let invalid = || {
        WorkspaceError::ConstraintViolation(format!(
            "{table} payload has an invalid value for `{column}`"
        ))
    };
    Ok(match value {
        serde_json::Value::Null => SqlValue::Null,
        serde_json::Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        serde_json::Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().ok_or_else(invalid)?),
        },
        serde_json::Value::String(s) => SqlValue::Text(s.clone()),
        serde_json::Value::Object(o) => {
            let hex = o
                .get("$blob")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(invalid)?;
            SqlValue::Blob(decode_hex(hex).ok_or_else(invalid)?)
        }
        serde_json::Value::Array(_) => return Err(invalid()),
    })
}

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_follows_card_kind_order() {
        let kinds: Vec<CardKind> = registry().iter().map(|h| h.kind()).collect();
        assert_eq!(kinds, CardKind::ALL);
        for kind in CardKind::ALL {
            assert_eq!(handler(*kind).kind(), *kind);
        }
    }

    #[test]
    fn hex_round_trips() {
        let bytes = vec![0u8, 1, 0xab, 0xff];
        let json = sql_to_json(ValueRef::Blob(&bytes));
        assert_eq!(json_to_sql("t", "c", &json).unwrap(), SqlValue::Blob(bytes));
        assert!(decode_hex("abc").is_none());
        assert!(decode_hex("zz").is_none());
    }
}
