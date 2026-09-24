-- 0024_device_scoped_locators.sql
-- Device identity and device-scoped filesystem shortcut locators (ADR-0012).
--
-- Tables:
--   local_meta                 key/value facts about THIS installation. Holds
--                              `device_id` (UUIDv7) and `device_name`. Never
--                              synced (ADR-0011/0012; `LOCAL_ONLY_TABLES`).
--   known_devices              every device this workspace has heard of, with
--                              its human name. Seeded with this device; other
--                              devices' names arrive with the sync handshake
--                              (S1), not as journaled rows, so it is local-only
--                              too. Read to label foreign shortcuts
--                              ("On <name>").
--   filesystem_alias_locators  one platform locator per (card, device): a macOS
--                              bookmark or a `path:v1:` blob. Never synced.
--                              `ON DELETE CASCADE`: a locator lives exactly as
--                              long as its card row (empty trash, not the
--                              detail row, ends it), so the kind's journal codec
--                              can drop and re-apply `filesystem_aliases`
--                              without losing this device's locator.
--   filesystem_aliases         gains `origin_device_id` (the device that created
--                              the shortcut and wrote `path_hint`); loses
--                              `locator_blob`.
--
-- Two-phase migration. This file is the DDL that pure SQL can express. The
-- runner then calls the Rust step registered with version 24
-- (`repositories::devices::migrate_0024`), INSIDE THE SAME TRANSACTION:
--   1. ensure the device identity (a UUIDv7 cannot be minted in SQL, and the
--      legacy rows must be attributed to the device that runs the migration);
--   2. backfill: every alias with `origin_device_id IS NULL` gets this device
--      as origin and its `locator_blob` is copied into
--      `filesystem_alias_locators` for this device (INSERT OR IGNORE: running
--      it twice changes nothing);
--   3. `ALTER TABLE filesystem_aliases DROP COLUMN locator_blob`.
-- A failure anywhere rolls back the file and the Rust step together, so a
-- database is either fully at 0024 or untouched.
--
-- Why DROP COLUMN and not a create-copy-drop-rename rebuild (0021 pattern):
-- `locator_blob` is not part of any index, constraint, view or trigger. The
-- only triggers on `filesystem_aliases` (0022 `search_alias_*`, 0023
-- `change_seq_filesystem_aliases_*`) read `card_id`, `display_name` and
-- `path_hint`, so SQLite's DROP COLUMN (>= 3.35; the bundled library is newer)
-- re-validates them unchanged. A rebuild would have had to drop and recreate
-- all six triggers for no benefit. `migration_0024_*` tests assert the
-- triggers still fire after the drop.

CREATE TABLE local_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE known_devices (
    device_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL
);

-- NULL allowed at DDL time only: the Rust step fills every legacy row, and
-- every write path sets it from `local_meta.device_id`.
ALTER TABLE filesystem_aliases ADD COLUMN origin_device_id TEXT;

CREATE TABLE filesystem_alias_locators (
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    locator_blob BLOB NOT NULL,
    PRIMARY KEY (card_id, device_id)
);
