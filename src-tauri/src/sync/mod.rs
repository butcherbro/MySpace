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
//! reference) plus the HLC of every register in it. Replay merges registers by
//! last-writer-wins, which converges regardless of delivery order and needs no
//! deterministic re-execution of the original command (ids minted inside a
//! command, such as trash batch ids or a duplicated board's subtree, arrive as
//! data). The originating command is kept as the row's `op`
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
    /// Rows still pending after the retry passes (this and earlier batches).
    pub pending: usize,
    /// Ids of conflict-copy notes created by this batch.
    pub conflict_copies: Vec<String>,
    /// Local board ids whose rendered content changed (their `change_seq`
    /// was bumped by the 0023 triggers). A transport notifies the UI with it.
    pub touched_boards: Vec<String>,
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
