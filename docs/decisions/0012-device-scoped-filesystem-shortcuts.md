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
