//! Device sync, ADR-0011: S1 + S2 are a transport-agnostic change journal and
//! the engine that replays a peer's journal; S3 is the LAN transport
//! ([`lan`], [`server`], [`peer_client`], [`discovery`], [`pairing`],
//! [`tls`], [`peers`]), which only moves [`ChangeRow`]s and asset blobs
//! between [`journal::changes_since`] on one device and
//! [`replay::apply_remote`] on another.
//!
//! ```text
//! local write ─► Workspace::apply ─► sync::funnel::apply (one BEGIN IMMEDIATE)
//!                                     ├─ Mutation::execute   (repositories; triggers mark
//!                                     │                       temp.sync_dirty per entity/register)
//!                                     └─ tracking::flush     (one `changes` row per dirty entity:
//!                                                             HLC + entity image, entity_clocks)
//! peer rows  ─► Workspace::apply(ApplySyncChanges) ─► replay::apply_remote
//!                                     (record in `changes`, LWW per register, park/retry,
//!                                      purge tombstones, conflict copies)
//! ```
//!
//! Journal rows are STATE, not commands: each row carries the full image of
//! one entity (a board, a card with its kind payload, an asset, a quick-board
//! reference, a connector) plus the HLC of every register in it. Replay
//! merges registers by last-writer-wins, which converges regardless of
//! delivery order and needs no deterministic re-execution of the original
//! command (ids minted inside a command, such as trash batch ids or a
//! duplicated board's subtree, arrive as data). The originating command is kept as the row's `op`
//! ([`crate::domain::mutation::Mutation::op_name`]).

pub mod compact;
pub mod discovery;
pub mod funnel;
pub mod hlc;
pub mod image;
pub mod journal;
pub mod lan;
pub mod pairing;
pub mod peer_client;
pub mod peers;
pub mod replay;
pub mod server;
pub mod snapshot;
pub mod spake2;
pub mod tls;
pub mod tracking;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::domain::errors::WorkspaceError;

/// Wire id of the workspace root board. Every installation bootstraps its own
/// Home board with its own UUID; journal rows name it by this alias so a
/// board created under Home on one device lands under Home on the other.
pub const ROOT_BOARD_ALIAS: &str = "@home";

/// `op` of a purge tombstone row (Empty Trash, ADR-0011 Decision 5).
pub const OP_PURGE: &str = "purge";
/// `op` of the rows written by the one-time journal backfill.
pub const OP_SNAPSHOT: &str = "snapshot";
/// `op` of a conflict copy created while replaying (Decision 3).
pub const OP_CONFLICT_COPY: &str = "sync.conflict_copy";

/// Entity kinds a journal row can carry (`changes.entity_kind`).
pub const ENTITY_BOARD: &str = "board";
pub const ENTITY_CARD: &str = "card";
pub const ENTITY_ASSET: &str = "asset";
pub const ENTITY_QUICK_BOARD: &str = "quick_board";
pub const ENTITY_CONNECTOR: &str = "connector";
/// Every entity kind this build replays (each has registers in
/// [`image::registers`]).
pub const ENTITY_KINDS: &[&str] = &[
    ENTITY_BOARD,
    ENTITY_CARD,
    ENTITY_ASSET,
    ENTITY_QUICK_BOARD,
    ENTITY_CONNECTOR,
];

/// One journal row as exchanged between devices. `received_at` and `seq`
/// are local and never travel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRow {
    pub origin_device_id: String,
    pub hlc: String,
    pub entity_kind: String,
    pub entity_id: String,
    pub op: String,
    pub payload_json: String,
}

/// What [`replay::apply_remote`] did with a batch.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    /// Rows in the batch.
    pub received: usize,
    /// Rows (including retried pending ones) that changed at least one
    /// register or purged an entity.
    pub applied: usize,
    /// Rows already held in `changes`, or held once and compacted away
    /// (re-delivery): ignored entirely.
    pub duplicates: usize,
    /// Rows recorded but losing every register to a newer local value.
    pub superseded: usize,
    /// Rows recorded but dropped because their entity (or its board) was
    /// purged: a purge is final.
    pub dropped_purged: usize,
    /// Rows recorded but refused as invalid (bad payload, unsafe asset path).
    pub rejected: usize,
    /// Rows parked in `pending_changes` by this batch.
    pub parked: usize,
    /// Rows this batch LEFT deferred for a newer build (unknown kind, register
    /// or payload version), never retried until the build changes. Includes
    /// rows re-deferred by the retry passes and rows that also applied their
    /// known registers (an unknown register; those are counted in `applied`
    /// or `superseded` too, so the categories can sum above `received`).
    #[serde(default)]
    pub deferred: usize,
    /// Rows still pending after the retry passes (this and earlier batches,
    /// deferred ones included).
    pub pending: usize,
    /// Ids of conflict-copy notes created by this batch.
    pub conflict_copies: Vec<String>,
    /// Local board ids whose rendered content changed (their `change_seq`
    /// was bumped by the 0023 triggers). A transport notifies the UI with it.
    pub touched_boards: Vec<String>,
}

/// `local_meta` key of the [`capabilities`] the deferred rows were last
/// tried against.
pub const CAPABILITIES_KEY: &str = "sync_capabilities";

/// What this build can interpret in a journal row: the payload version, every
/// entity kind with its registers, the card kinds and the schema version.
/// When it differs from the stored value, replay releases the deferred rows.
pub fn capabilities() -> String {
    let entities: Vec<String> = ENTITY_KINDS
        .iter()
        .map(|kind| format!("{kind}:{}", image::registers(kind).join(",")))
        .collect();
    let cards: Vec<&str> = crate::domain::card_kind::CardKind::ALL
        .iter()
        .map(|k| k.as_str())
        .collect();
    format!(
        "v{}|{}|cards:{}|schema:{}",
        image::IMAGE_VERSION,
        entities.join(";"),
        cards.join(","),
        crate::db::migrations::max_app_version()
    )
}

/// Replays the rows parked in `pending_changes` once, if there are any.
///
/// Повторы паркованных строк идут только внутри реплея пришедшей страницы.
/// Строки `connector`, поставленные в очередь миграцией 0027, ждали бы
/// первой непустой страницы от пира; при старте они применяются сразу.
/// Отложенные для новой сборки строки пробуются, только когда сменились
/// [`capabilities`] (обновление): иначе транзакция писателя при каждом
/// старте ничего бы не изменила.
pub fn retry_pending_blocking(
    ws: &crate::app::Workspace,
) -> Result<Option<ApplyReport>, WorkspaceError> {
    let due = ws.read_blocking(|conn| {
        let deferred = journal::deferred_count(conn)?;
        let parked = journal::pending_count(conn)? - deferred;
        let changed = || -> Result<bool, WorkspaceError> {
            Ok(compact::meta(conn, CAPABILITIES_KEY)?.as_deref() != Some(&capabilities()))
        };
        Ok(parked > 0 || (deferred > 0 && changed()?))
    })?;
    if !due {
        return Ok(None);
    }
    ws.apply_blocking(crate::domain::mutation::Mutation::ApplySyncChanges(
        Vec::new(),
    ))?
    .into_sync_report()
    .map(Some)
}

/// This installation's `device_id` (ADR-0012).
pub fn device_id(conn: &Connection) -> Result<String, WorkspaceError> {
    crate::repositories::devices::current_device_id(conn)
}

/// The local root board id.
pub fn root_board_id(conn: &Connection) -> Result<String, WorkspaceError> {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .optional()?
    .ok_or_else(|| WorkspaceError::NotFound("workspace".into()))
}

/// Local board id → wire id (the root becomes [`ROOT_BOARD_ALIAS`]).
pub fn board_to_wire(root: &str, id: &str) -> String {
    if id == root {
        ROOT_BOARD_ALIAS.to_string()
    } else {
        id.to_string()
    }
}

/// Wire board id → local id.
pub fn board_from_wire(root: &str, id: &str) -> String {
    if id == ROOT_BOARD_ALIAS {
        root.to_string()
    } else {
        id.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// [`ENTITY_KINDS`] and `image::registers` agree: a listed kind without
    /// registers would be deferred forever by replay.
    #[test]
    fn every_entity_kind_has_registers() {
        for kind in ENTITY_KINDS {
            assert!(!image::registers(kind).is_empty(), "{kind}");
        }
    }
}
