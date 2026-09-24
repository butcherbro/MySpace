//! Entity images: the payload of a journal row (`changes.payload_json`).
//!
//! An image is the full synced state of ONE entity plus the HLC of each of its
//! registers. A register is a group of columns that one user gesture changes
//! together and that last-writer-wins resolves as a unit:
//!
//! | entity        | register | columns                                              |
//! |---------------|----------|------------------------------------------------------|
//! | `card`        | `place`  | board_id, x, y, width, height, z_index, unsorted     |
//! | `card`        | `life`   | deleted_at, trash_batch_id                           |
//! | `card`        | `body`   | kind + the kind's detail row (`to_payload`)          |
//! | `board`       | `meta`   | title, color_token, symbol, cover_asset_id           |
//! | `board`       | `place`  | parent_board_id                                      |
//! | `board`       | `life`   | deleted_at, trash_batch_id                           |
//! | `asset`       | `body`   | every column except `id`                             |
//! | `quick_board` | `body`   | present, sort_order                                  |
//!
//! Never in an image: `revision` / `updated_at` (local write counters), the
//! `workspace_id` (each device has its own workspace row), `change_seq` and
//! the search index (derived), and every `LOCAL_ONLY_TABLES` row (locators,
//! viewport, device names). The root board travels as [`ROOT_BOARD_ALIAS`],
//! and so does any `*board_id` value that names it.
//!
//! Envelope (version 1):
//! `{"v":1, "clocks":{register: hlc}, "prev":{register: hlc}, "state":{…},
//!   "cause":{"kind":…, "id":…}}` or, for a tombstone, `{"v":1, "purge":true}`.
//! `prev` is the clock the origin device held for a register before this
//! change set it: replay uses it to tell a sequential edit from a concurrent
//! one (conflict copies, Decision 3).
//!
//! [`ROOT_BOARD_ALIAS`]: super::ROOT_BOARD_ALIAS

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    board_from_wire, board_to_wire, ENTITY_ASSET, ENTITY_BOARD, ENTITY_CARD, ENTITY_QUICK_BOARD,
};
use crate::domain::card_kind::{handler, CardKind};
use crate::domain::errors::WorkspaceError;
use crate::domain::models::Frame;

/// Payload format version written by this build.
pub const IMAGE_VERSION: u32 = 1;

pub const REG_PLACE: &str = "place";
pub const REG_LIFE: &str = "life";
pub const REG_BODY: &str = "body";
pub const REG_META: &str = "meta";

/// The registers of an entity kind (empty for an unknown kind).
pub fn registers(entity_kind: &str) -> &'static [&'static str] {
    match entity_kind {
        ENTITY_CARD => &[REG_PLACE, REG_LIFE, REG_BODY],
        ENTITY_BOARD => &[REG_META, REG_PLACE, REG_LIFE],
        ENTITY_ASSET | ENTITY_QUICK_BOARD => &[REG_BODY],
        _ => &[],
    }
}

/// The mutation that produced a row (debugging aid; replay ignores it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cause {
    pub kind: String,
    pub id: String,
}

/// A decoded `payload_json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u32,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub purge: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub clocks: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub prev: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub state: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<Cause>,
}

impl Envelope {
    pub fn tombstone() -> Self {
        Self {
            v: IMAGE_VERSION,
            purge: true,
            clocks: BTreeMap::new(),
            prev: BTreeMap::new(),
            state: Value::Null,
            cause: None,
        }
    }

    pub fn decode(text: &str) -> Result<Self, WorkspaceError> {
        let envelope: Envelope = serde_json::from_str(text).map_err(|e| {
            WorkspaceError::ConstraintViolation(format!("invalid change payload: {e}"))
        })?;
        if envelope.v != IMAGE_VERSION {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "unsupported change payload version {}",
                envelope.v
            )));
        }
        Ok(envelope)
    }

    pub fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".into())
    }
}

// ---- reading local state ---------------------------------------------------

/// Rewrites every `*board_id` string in a detail payload with `map`.
fn map_board_ids(detail: &mut Value, map: impl Fn(&str) -> String) {
    if let Value::Object(object) = detail {
        for (key, value) in object.iter_mut() {
            if key.ends_with("board_id") {
                if let Value::String(id) = value {
                    *id = map(id);
                }
            }
        }
    }
}

/// The synced state of one entity, or `None` when it does not exist here.
/// `local_id` is the local id (the root's real UUID, not the alias).
pub fn read_state(
    conn: &Connection,
    entity_kind: &str,
    local_id: &str,
    root: &str,
) -> Result<Option<Value>, WorkspaceError> {
    match entity_kind {
        ENTITY_CARD => read_card(conn, local_id, root),
        ENTITY_BOARD => read_board(conn, local_id, root),
        ENTITY_ASSET => read_asset(conn, local_id),
        ENTITY_QUICK_BOARD => read_quick_board(conn, local_id),
        other => Err(WorkspaceError::ConstraintViolation(format!(
            "unknown entity kind: {other}"
        ))),
    }
}

fn read_card(conn: &Connection, id: &str, root: &str) -> Result<Option<Value>, WorkspaceError> {
    let row = conn
        .query_row(
            "SELECT board_id, kind, x, y, width, height, z_index, unsorted, created_at,
                    deleted_at, trash_batch_id
             FROM cards WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    json!({
                        "x": r.get::<_, f64>(2)?,
                        "y": r.get::<_, f64>(3)?,
                        "width": r.get::<_, f64>(4)?,
                        "height": r.get::<_, f64>(5)?,
                        "z_index": r.get::<_, i64>(6)?,
                        "unsorted": r.get::<_, i64>(7)? != 0,
                        "created_at": r.get::<_, i64>(8)?,
                        "deleted_at": r.get::<_, Option<i64>>(9)?,
                        "trash_batch_id": r.get::<_, Option<String>>(10)?,
                    }),
                ))
            },
        )
        .optional()?;
    let Some((board_id, kind, mut state)) = row else {
        return Ok(None);
    };
    let detail = match kind.parse::<CardKind>() {
        Ok(k) => match handler(k).to_payload(conn, id) {
            Ok(mut detail) => {
                map_board_ids(&mut detail, |b| board_to_wire(root, b));
                detail
            }
            Err(WorkspaceError::NotFound(_)) => Value::Null,
            Err(e) => return Err(e),
        },
        Err(_) => Value::Null,
    };
    if let Value::Object(object) = &mut state {
        object.insert(
            "board_id".into(),
            Value::String(board_to_wire(root, &board_id)),
        );
        object.insert("kind".into(), Value::String(kind));
        object.insert("detail".into(), detail);
    }
    Ok(Some(state))
}

fn read_board(conn: &Connection, id: &str, root: &str) -> Result<Option<Value>, WorkspaceError> {
    conn.query_row(
        "SELECT parent_board_id, title, color_token, symbol, cover_asset_id, created_at,
                deleted_at, trash_batch_id
         FROM boards WHERE id = ?1",
        [id],
        |r| {
            let parent: Option<String> = r.get(0)?;
            Ok(json!({
                "parent_board_id": parent.map(|p| board_to_wire(root, &p)),
                "title": r.get::<_, String>(1)?,
                "color_token": r.get::<_, String>(2)?,
                "symbol": r.get::<_, Option<String>>(3)?,
                "cover_asset_id": r.get::<_, Option<String>>(4)?,
                "created_at": r.get::<_, i64>(5)?,
                "deleted_at": r.get::<_, Option<i64>>(6)?,
                "trash_batch_id": r.get::<_, Option<String>>(7)?,
            }))
        },
    )
    .optional()
    .map_err(WorkspaceError::from)
}

fn read_asset(conn: &Connection, id: &str) -> Result<Option<Value>, WorkspaceError> {
    conn.query_row(
        "SELECT file_path, mime_type, file_name, width, height, size_bytes, created_at, sha256
         FROM assets WHERE id = ?1",
        [id],
        |r| {
            Ok(json!({
                "file_path": r.get::<_, String>(0)?,
                "mime_type": r.get::<_, String>(1)?,
                "file_name": r.get::<_, String>(2)?,
                "width": r.get::<_, Option<i64>>(3)?,
                "height": r.get::<_, Option<i64>>(4)?,
                "size_bytes": r.get::<_, i64>(5)?,
                "created_at": r.get::<_, i64>(6)?,
                "sha256": r.get::<_, Option<String>>(7)?,
            }))
        },
    )
    .optional()
    .map_err(WorkspaceError::from)
}

/// A quick-board reference always has an image: `present: false` is how a
/// removal travels (the row itself is hard-deleted).
fn read_quick_board(conn: &Connection, board_id: &str) -> Result<Option<Value>, WorkspaceError> {
    let row = conn
        .query_row(
            "SELECT sort_order, created_at FROM quick_boards WHERE board_id = ?1",
            [board_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()?;
    Ok(Some(match row {
        Some((sort_order, created_at)) => {
            json!({ "present": true, "sort_order": sort_order, "created_at": created_at })
        }
        None => json!({ "present": false }),
    }))
}

// ---- field access for replay -------------------------------------------------

fn invalid(what: &str) -> WorkspaceError {
    WorkspaceError::ConstraintViolation(format!("change payload: invalid `{what}`"))
}

pub(crate) fn get_str<'a>(state: &'a Value, key: &str) -> Result<&'a str, WorkspaceError> {
    state
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(key))
}

pub(crate) fn get_opt_str(state: &Value, key: &str) -> Result<Option<String>, WorkspaceError> {
    match state.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(invalid(key)),
    }
}

pub(crate) fn get_i64(state: &Value, key: &str) -> Result<i64, WorkspaceError> {
    state
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid(key))
}

pub(crate) fn get_opt_i64(state: &Value, key: &str) -> Result<Option<i64>, WorkspaceError> {
    match state.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_i64().map(Some).ok_or_else(|| invalid(key)),
    }
}

fn get_f64(state: &Value, key: &str) -> Result<f64, WorkspaceError> {
    state
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| invalid(key))
}

fn get_bool(state: &Value, key: &str) -> Result<bool, WorkspaceError> {
    state
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid(key))
}

// ---- writing registers (replay) ---------------------------------------------

/// A card's `place` register, validated.
pub struct CardPlace {
    pub board_id: String,
    pub frame: Frame,
    pub z_index: i64,
    pub unsorted: bool,
}

pub fn card_place(state: &Value, root: &str) -> Result<CardPlace, WorkspaceError> {
    let frame = Frame {
        x: get_f64(state, "x")?,
        y: get_f64(state, "y")?,
        width: get_f64(state, "width")?,
        height: get_f64(state, "height")?,
    };
    frame.validate()?;
    Ok(CardPlace {
        board_id: board_from_wire(root, get_str(state, "board_id")?),
        frame,
        z_index: get_i64(state, "z_index")?,
        unsorted: get_bool(state, "unsorted")?,
    })
}

/// The card kind of an image, validated against the registry.
pub fn card_kind(state: &Value) -> Result<CardKind, WorkspaceError> {
    get_str(state, "kind")?.parse::<CardKind>()
}

/// The detail payload of a card image with wire board ids mapped to local
/// ones (`Null` when the origin had no detail row).
pub fn card_detail(state: &Value, root: &str) -> Value {
    let mut detail = state.get("detail").cloned().unwrap_or(Value::Null);
    map_board_ids(&mut detail, |b| board_from_wire(root, b));
    detail
}

/// Inserts a card that does not exist locally from its full image.
pub fn insert_card(
    conn: &Connection,
    id: &str,
    state: &Value,
    root: &str,
    now: i64,
) -> Result<(), WorkspaceError> {
    let place = card_place(state, root)?;
    let kind = card_kind(state)?;
    conn.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision,
                            created_at, updated_at, deleted_at, trash_batch_id, unsorted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10, ?11, ?12, ?13)",
        params![
            id,
            place.board_id,
            kind.as_str(),
            place.frame.x,
            place.frame.y,
            place.frame.width,
            place.frame.height,
            place.z_index,
            get_opt_i64(state, "created_at")?.unwrap_or(now),
            now,
            get_opt_i64(state, "deleted_at")?,
            get_opt_str(state, "trash_batch_id")?,
            i64::from(place.unsorted),
        ],
    )?;
    write_card_body(conn, id, kind, None, state, root)
}

pub fn update_card_place(
    conn: &Connection,
    id: &str,
    place: &CardPlace,
) -> Result<(), WorkspaceError> {
    conn.execute(
        "UPDATE cards SET board_id = ?2, x = ?3, y = ?4, width = ?5, height = ?6, z_index = ?7,
                          unsorted = ?8
         WHERE id = ?1",
        params![
            id,
            place.board_id,
            place.frame.x,
            place.frame.y,
            place.frame.width,
            place.frame.height,
            place.z_index,
            i64::from(place.unsorted)
        ],
    )?;
    Ok(())
}

pub fn update_card_life(conn: &Connection, id: &str, state: &Value) -> Result<(), WorkspaceError> {
    conn.execute(
        "UPDATE cards SET deleted_at = ?2, trash_batch_id = ?3 WHERE id = ?1",
        params![
            id,
            get_opt_i64(state, "deleted_at")?,
            get_opt_str(state, "trash_batch_id")?
        ],
    )?;
    Ok(())
}

/// Replaces a card's kind + detail row. `old_kind` is the kind stored locally
/// (its detail row is removed first when the kind changes).
pub fn write_card_body(
    conn: &Connection,
    id: &str,
    kind: CardKind,
    old_kind: Option<CardKind>,
    state: &Value,
    root: &str,
) -> Result<(), WorkspaceError> {
    if let Some(old) = old_kind {
        if old != kind {
            handler(old).delete_details(conn, &[id.to_string()])?;
            conn.execute(
                "UPDATE cards SET kind = ?2 WHERE id = ?1",
                params![id, kind.as_str()],
            )?;
        }
    }
    let detail = card_detail(state, root);
    if detail.is_null() {
        handler(kind).delete_details(conn, &[id.to_string()])?;
        return Ok(());
    }
    handler(kind).from_payload(conn, id, &detail)
}

/// Bumps the local write counters of a card touched by a replay.
pub fn touch_card(conn: &Connection, id: &str, now: i64) -> Result<(), WorkspaceError> {
    conn.execute(
        "UPDATE cards SET revision = revision + 1, updated_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

/// Inserts a board that does not exist locally (plus its default view state,
/// which is local and never travels).
pub fn insert_board(
    conn: &Connection,
    id: &str,
    state: &Value,
    root: &str,
    now: i64,
) -> Result<(), WorkspaceError> {
    let parent = get_opt_str(state, "parent_board_id")?
        .map(|p| board_from_wire(root, &p))
        .ok_or_else(|| invalid("parent_board_id"))?;
    conn.execute(
        "INSERT INTO boards (id, workspace_id, parent_board_id, title, color_token, symbol,
                             cover_asset_id, revision, created_at, updated_at, deleted_at,
                             trash_batch_id)
         VALUES (?1, (SELECT id FROM workspaces LIMIT 1), ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, ?10)",
        params![
            id,
            parent,
            get_str(state, "title")?,
            get_str(state, "color_token")?,
            get_opt_str(state, "symbol")?,
            get_opt_str(state, "cover_asset_id")?,
            get_opt_i64(state, "created_at")?.unwrap_or(now),
            now,
            get_opt_i64(state, "deleted_at")?,
            get_opt_str(state, "trash_batch_id")?,
        ],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO board_view_states (board_id, viewport_x, viewport_y, zoom, revision, updated_at)
         VALUES (?1, 0, 0, 1, 1, ?2)",
        params![id, now],
    )?;
    Ok(())
}

pub fn update_board_meta(conn: &Connection, id: &str, state: &Value) -> Result<(), WorkspaceError> {
    conn.execute(
        "UPDATE boards SET title = ?2, color_token = ?3, symbol = ?4, cover_asset_id = ?5 WHERE id = ?1",
        params![
            id,
            get_str(state, "title")?,
            get_str(state, "color_token")?,
            get_opt_str(state, "symbol")?,
            get_opt_str(state, "cover_asset_id")?,
        ],
    )?;
    Ok(())
}

pub fn update_board_parent(
    conn: &Connection,
    id: &str,
    parent: &str,
) -> Result<(), WorkspaceError> {
    conn.execute(
        "UPDATE boards SET parent_board_id = ?2 WHERE id = ?1",
        params![id, parent],
    )?;
    Ok(())
}

pub fn update_board_life(conn: &Connection, id: &str, state: &Value) -> Result<(), WorkspaceError> {
    conn.execute(
        "UPDATE boards SET deleted_at = ?2, trash_batch_id = ?3 WHERE id = ?1",
        params![
            id,
            get_opt_i64(state, "deleted_at")?,
            get_opt_str(state, "trash_batch_id")?
        ],
    )?;
    Ok(())
}

pub fn touch_board(conn: &Connection, id: &str, now: i64) -> Result<(), WorkspaceError> {
    conn.execute(
        "UPDATE boards SET revision = revision + 1, updated_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

/// Inserts or updates an asset row. The file name must be a single safe path
/// component: a peer can never make this device read or write outside its
/// asset directory.
pub fn upsert_asset(conn: &Connection, id: &str, state: &Value) -> Result<(), WorkspaceError> {
    let file_path = get_str(state, "file_path")?;
    if !crate::is_safe_asset_name(file_path) {
        return Err(invalid("file_path"));
    }
    if let Some(sha) = get_opt_str(state, "sha256")? {
        if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(invalid("sha256"));
        }
    }
    conn.execute(
        "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at, sha256)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
            file_path = excluded.file_path, mime_type = excluded.mime_type,
            file_name = excluded.file_name, width = excluded.width, height = excluded.height,
            size_bytes = excluded.size_bytes, created_at = excluded.created_at,
            sha256 = excluded.sha256",
        params![
            id,
            file_path,
            get_str(state, "mime_type")?,
            get_str(state, "file_name")?,
            get_opt_i64(state, "width")?,
            get_opt_i64(state, "height")?,
            get_i64(state, "size_bytes")?,
            get_i64(state, "created_at")?,
            get_opt_str(state, "sha256")?,
        ],
    )?;
    Ok(())
}

/// Applies a quick-board image: upsert when present, delete otherwise.
pub fn write_quick_board(
    conn: &Connection,
    board_id: &str,
    state: &Value,
    now: i64,
) -> Result<(), WorkspaceError> {
    if get_bool(state, "present")? {
        conn.execute(
            "INSERT INTO quick_boards (board_id, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(board_id) DO UPDATE SET sort_order = excluded.sort_order, updated_at = excluded.updated_at",
            params![
                board_id,
                get_i64(state, "sort_order")?,
                get_opt_i64(state, "created_at")?.unwrap_or(now),
                now
            ],
        )?;
    } else {
        conn.execute("DELETE FROM quick_boards WHERE board_id = ?1", [board_id])?;
    }
    Ok(())
}
