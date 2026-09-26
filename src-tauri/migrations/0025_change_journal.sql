-- 0025_change_journal.sql
-- Device sync S1 (ADR-0011): the change journal and its local bookkeeping.
--
-- Tables:
--   changes          THE WIRE FORMAT. One row per journaled change of one
--                    entity, identified by (origin_device_id, hlc). Rows
--                    written here by this device (origin = this device) and
--                    rows received from peers (original origin/hlc kept) are
--                    both served onward by `sync::journal::changes_since`, so
--                    star and mesh topologies both work. `seq` is local
--                    insertion order only and is never exchanged.
--                    `payload_json` is a versioned entity image
--                    (`sync::image`), never raw SQL and never device-local
--                    data. `received_at` is local (when this device stored it).
--   entity_clocks    LWW basis: the HLC of the value currently applied for
--                    each (entity, register). A register is a group of columns
--                    that changes together (card `place`/`life`/`body`, board
--                    `meta`/`place`/`life`, asset/quick-board `body`), so a
--                    concurrent move and edit of the same card both survive.
--   purged           tombstones written by Empty Trash (ADR-0011 Decision 5):
--                    a purged entity is never resurrected by a later change.
--   pending_changes  received changes that could not apply yet because a
--                    dependency (the card's board, a referenced asset) has not
--                    arrived. Retried after every batch, in HLC order.
--   sync_cursors     per origin device, the highest HLC this device holds in
--                    `changes` (a vector clock). What a peer is asked for.
--
-- `entity_clocks`, `purged`, `pending_changes` and `sync_cursors` are
-- local-only (`LOCAL_ONLY_TABLES`); only `changes` rows travel.
--
-- The UNIQUE constraint is the (origin_device_id, hlc) index (idempotent
-- receive). `idx_changes_hlc` serves `changes_since`, which pages in HLC order.

CREATE TABLE changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    origin_device_id TEXT NOT NULL,
    hlc TEXT NOT NULL,
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    op TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    UNIQUE (origin_device_id, hlc)
);

CREATE INDEX idx_changes_hlc ON changes(hlc);
CREATE INDEX idx_changes_entity ON changes(entity_kind, entity_id);

CREATE TABLE entity_clocks (
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    field TEXT NOT NULL,
    hlc TEXT NOT NULL,
    PRIMARY KEY (entity_kind, entity_id, field)
) WITHOUT ROWID;

CREATE TABLE purged (
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    hlc TEXT NOT NULL,
    PRIMARY KEY (entity_kind, entity_id)
) WITHOUT ROWID;

CREATE TABLE pending_changes (
    origin_device_id TEXT NOT NULL,
    hlc TEXT NOT NULL,
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    op TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (origin_device_id, hlc)
);

CREATE TABLE sync_cursors (
    peer_device_id TEXT PRIMARY KEY,
    last_hlc TEXT NOT NULL
);
