# ADR-0012: Filesystem shortcuts are board content; their locators belong to a device

- **Status:** Accepted 2026-09-24
- **Date:** 2026-09-24
- **Context:** the workspace will live on several machines (a Mac and a Windows
  PC today; other people's machines later, ADR-0011). Folder and file
  shortcuts (`filesystem_alias` cards) point at paths that only exist on the
  machine where they were created: a macOS security-scoped bookmark is
  meaningless on Windows, and `C:\Users\…` is meaningless on a Mac. The
  question is what the other device shows, and what the sync journal carries.

## Options considered

| Option | Verdict | Why |
|---|---|---|
| A. Do not sync shortcut cards at all; each device keeps its own | **Rejected** | The journal is per-row last-writer-wins with tombstones. A card present on one device and absent on the other is indistinguishable from "deleted there", so the next exchange deletes it everywhere. Boards also render with holes. |
| B. Sync the card and its locator bytes as one row | **Rejected** | The locator is platform-bound. The other device would show a card that never opens, and any "re-point" there would overwrite the origin's locator. |
| C. Sync the card (frame, name, path hint, origin device); keep locators in a per-device table that is never synced | **Chosen** | The board looks the same everywhere. Each device may hold its own locator for the same card, so one shortcut can open on both machines after a one-time "point to local folder". Nothing platform-bound ever leaves the device. |

## Decision

1. **Device identity.** Each installation has a stable `device_id` (UUIDv7)
   and a human `device_name` (defaults to the machine's host name; editable).
   Stored in a `local_meta` table in the workspace database. Legacy rows are
   attributed to the device that runs migration 0024.
2. **Schema (migration 0024).** `filesystem_aliases` gains `origin_device_id`.
   Locator bytes move to `filesystem_alias_locators(card_id, device_id,
   locator_blob, PRIMARY KEY(card_id, device_id))`. The old `locator_blob`
   column is dropped after backfill. Sync (S1) will exclude the locators table
   and `local_meta`.
3. **Locator format.** Blobs are self-describing: macOS bookmark bytes as
   today; every other platform stores `path:v1:<utf-8 absolute path>`. A
   resolver given a blob it cannot read returns a `LocatorError`, never a
   panic.
4. **DTO.** `FilesystemAliasDto` gains `originDeviceId`, `originDeviceName`
   and `local: bool` (this device holds a locator for the card).
5. **UI.** A shortcut with `local: false` renders dimmed with a badge
   "On <origin device name>". Open and preview are disabled; the context menu
   offers "Point to a folder on this computer…" which picks a folder, creates
   this device's locator, and leaves the origin device's locator untouched.
   A shortcut whose locator exists but fails to resolve keeps the existing
   `missing` / `permission_lost` states.
6. **Path hint.** `path_hint` remains display-only and is synced as written by
   the origin device, so a Windows user sees the Mac path in the badge tooltip
   and understands why the card is foreign.

## Consequences

- One shortcut card can be usable on every device after a per-device
  re-point; users never see a card silently vanish.
- Sync excludes exactly two tables; no per-column filtering is needed.
- Moving a data folder between machines (or restoring a backup on another
  machine) is the same case as sync: the shortcuts show as foreign until
  re-pointed. This is testable today without a sync implementation.

## Status

Implemented 2026-09-24 in migration **0024** (`0024_device_scoped_locators.sql`
plus its Rust step `repositories::devices::migrate_0024`, run in the same
transaction).

- Schema: `local_meta(key, value)`, `known_devices(device_id, name,
  last_seen_at)`, `filesystem_alias_locators(card_id → cards(id) ON DELETE
  CASCADE, device_id, locator_blob, PRIMARY KEY(card_id, device_id))`,
  `filesystem_aliases.origin_device_id`; `filesystem_aliases.locator_blob` is
  dropped with `ALTER TABLE … DROP COLUMN` after the backfill (no trigger,
  index or constraint references it, so no rebuild was needed).
- Backfill: the device running 0024 mints its identity (UUIDv7, host name or
  "This computer"), becomes the origin of every legacy alias, and receives its
  locator bytes verbatim. Idempotent and atomic with the migration.
- Commands: `get_device_identity` → `{ deviceId, deviceName }`,
  `rename_device(name)`, `set_filesystem_alias_local_target(cardId, path)` →
  the updated alias. `list_folder_preview` returns status `foreign_device` and
  `open_folder_in_finder` refuses when this device holds no locator.
- DTO: `originDeviceId`, `originDeviceName` (null when unknown; the UI shows
  "another device"), `local`.
- Sync exclusion: `domain::mutation::LOCAL_ONLY_TABLES` (`local_meta`,
  `filesystem_alias_locators`, `board_view_states`, `known_devices`) and
  `Mutation::is_local_only()` (`SaveViewport`, `SetFilesystemAliasLocalTarget`,
  `RenameDevice`). `known_devices` is local too: other devices' names arrive in
  the sync handshake, not as journaled rows. The alias kind's journal payload
  carries `origin_device_id` and never locator bytes.
- Not done: a settings surface for the device name (none exists yet).
- Moved databases: `local_meta.machine_fingerprint` is a SHA-256 over the OS
  machine id (`machine-uid`: `IOPlatformUUID` on macOS, `MachineGuid` on
  Windows, `/etc/machine-id` on Linux), the OS and the data directory path.
  Only if the machine id cannot be read does the short host name stand in for
  it (logged as `machine_id_unavailable`). Bootstrap compares it on every
  start. A database opened under another fingerprint (copied to another
  machine or user account, or a backup restored there) mints a new
  `device_id` and name, adds it to `known_devices` and keeps the previous
  device's row. Existing shortcuts keep their origin and the old device's
  locators, so they render "On <old name>" with "Point to…", as the
  Consequences above promise. The first fingerprinted start of an existing
  install only records the fingerprint.
- Renaming the host (or a DHCP-assigned host name) no longer rotates the
  identity; the host name is only the default `device_name`. Moving the data
  directory still does, and this device's own shortcuts then read as foreign
  until re-pointed.
