# ADR-0011: Device sync — direction and what the data layer must prepare now

- **Status:** Accepted 2026-09-24 (direction; implementation plan in `docs/plans/2026-09-24-p1-scalability-and-sync-readiness.md`)
- **Date:** 2026-09-24
- **Context:** the user wants the same workspace on a second Mac (same Wi-Fi,
  over the internet, or through a web surface later). Not a priority today, but
  the P1 refactors (writer actor, kind registry, backup 2.0) must not close the
  door. Reference product: Milanote is cloud-first; MySpace stays local-first
  and adds sync on top.

## Options considered

| Option | Verdict | Why |
|---|---|---|
| A. Sync the SQLite file itself (iCloud Drive / Dropbox / rsync) | **Rejected** | WAL + two writers corrupts the file; no merge, last copy wins, silent data loss. |
| B. Operation log (append-only change journal per device) replayed on the other device, LWW per row | **Chosen direction** | Fits the existing model: every mutation already passes through the backend with a revision; ids are UUIDv7 (globally unique); soft-delete gives tombstones. Transport-agnostic (LAN, relay server, web). |
| C. Table-level CRDT extension (cr-sqlite) | Deferred | Attractive (LWW per column for free) but pre-1.0, needs loading a native extension into the bundled SQLite, and hides conflict policy inside the extension. Re-evaluate after B's journal exists: the journal is the input a CRDT would need anyway. |
| D. Cloud-first server as the source of truth | Rejected for now | Turns the product into Milanote; loses offline-first and the single-file local story. A relay/web surface can sit on top of B later. |

## Decision (direction)

1. **Single mutation funnel.** All writes go through one backend entry point
   (the writer actor introduced by P1.1). That entry point is where a change
   journal row will be appended in the same transaction as the mutation.
   Consequence for P1: Tauri commands and MCP must not call repository
   functions directly any more; they call the funnel.
2. **Change journal table** (added when sync starts, not now):
   `changes(seq INTEGER PK, device_id TEXT, hlc TEXT, entity_kind TEXT,
   entity_id TEXT, op TEXT, payload_json TEXT, applied_at INTEGER)`.
   Hybrid logical clock (HLC) per device gives a total order without trusting
   wall clocks. `op` is a typed mutation (`card.move`, `note.update`,
   `board.trash`, …), i.e. the same command vocabulary the UI and MCP already use.
3. **Conflict policy.** Per-row last-writer-wins by HLC for frames, titles,
   colors, viewport; per-card LWW for `document_json` (whole document) in the
   first version. Trash is monotonic: a trash wins over a concurrent edit, a
   restore is a newer op. Concurrent edits of the same note on two devices are
   rare for one person and get a visible "conflict copy" note instead of a
   merge. Rich-text CRDT (Yjs-style) is explicitly out of scope until the
   journal exists.
4. **Assets are content-addressed.** `assets.sha256` becomes the identity used
   by sync and by backup 2.0 (this settles the backup question in favour of a
   content-addressed store over APFS clonefile: it is universal, deduplicates
   across devices, and lets a device fetch only the blobs it lacks).
5. **Tombstones survive Empty Trash.** Hard delete must leave a tombstone row
   (`purged(entity_id, hlc)`) so a device that was offline does not resurrect a
   purged entity. `empty_trash` will write tombstones when sync lands.
6. **Transport comes last.** Phase 1: LAN, mDNS discovery + HTTP over the local
   network, symmetric peers exchanging `changes` since the last known `seq`
   and pulling missing blobs by hash. Phase 2: an optional relay (small Rust
   service) for internet sync; the same protocol, the relay just stores the
   journal and blobs. Phase 3: a read-only web viewer over the relay.

## What this means for P1 (do now, costs almost nothing)

- P1.1 writer actor: expose one `apply(Mutation) -> Receipt` API; commands map
  1:1 onto `Mutation` variants. This is the journal hook.
- P1.2 backup 2.0: content-addressed asset store (`assets.sha256`, files stored
  as `assets/<sha256-prefix>/<sha256>`); dedup at import time replaces the
  startup favicon collapse.
- P1.3 kind registry: every kind declares how its detail rows serialise into a
  journal payload (`to_payload`/`from_payload`); adding a kind adds a payload
  codec, not a sync special case.
- Keep `updated_at` on every mutable row (already true) and add `device_id`
  only when the journal is introduced.
- Never rely on SQLite `rowid` or autoincrement ids in DTOs (already true).

## Non-goals until the journal exists

Real-time collaboration, multi-user permissions, merging rich text, cloud
accounts, mobile clients.

## Status

S1 (journal) and S2 (replay engine) implemented 2026-09-24, transport-agnostic
(no network code). Migration **0025** (`0025_change_journal.sql`), module
`src-tauri/src/sync/`, commands `sync_export_changes`, `sync_apply_changes`,
`sync_status`, tests `src-tauri/tests/sync_replay.rs`.

**Deviation from Decision 2: rows carry entity state, not commands.** A
journal row is the full image of ONE entity after the write (card row + kind
payload via `to_payload`, board row, asset row, quick-board reference) with the
HLC of each of its *registers*; replay merges registers by LWW. Command replay
was rejected while implementing: an LWW skip of a partial command (e.g. a
frame-only move losing to an older move-to-board) makes replicas diverge, and
re-executing commands needs every internally minted id (trash batches,
duplicated subtrees, link batches) and every staged file to be serialised. With
state, those ids simply arrive as data, and the merge converges in any delivery
order. The originating command is kept as the row's `op`
(`Mutation::op_name`, pinned by a snapshot test in `domain::mutation`).

- **Schema:** `changes(seq, origin_device_id, hlc, entity_kind, entity_id, op,
  payload_json, received_at, UNIQUE(origin_device_id, hlc))` + index on `hlc`;
  `entity_clocks(entity_kind, entity_id, field, hlc)` (`field` = register:
  the LWW unit is a register, not the whole entity); `purged`;
  `pending_changes`; `sync_cursors(peer_device_id, last_hlc)`. The last four
  and `local_meta` are in `LOCAL_ONLY_TABLES`; `changes` is the wire format.
- **HLC:** `{wall_ms:015}-{counter:05}-{device_id}`, string order = clock
  order; last value in `local_meta.hlc_last`, advanced inside the writer's
  IMMEDIATE transaction, so the app and the MCP server never issue a duplicate.
- **Registers:** card `place` (board, frame, z, unsorted), `life` (trash),
  `body` (kind + detail row); board `meta` (title, color, symbol, cover),
  `place` (parent), `life`; asset `body`; quick board `body` (present,
  order). The root board travels as `@home` (each install has its own Home id).
- **Journal write:** one `BEGIN IMMEDIATE` per mutation owned by
  `sync::funnel`; repository transactions became savepoints
  (`repositories::WriteTx`). Per-connection TEMP triggers record which
  entity/register a write actually changed; before `COMMIT` one row per touched
  entity is written in dependency order (boards parent-first, assets, cards,
  quick boards, then purges). Detection by trigger, so no mutation can forget
  to journal. Maintenance mutations (asset GC, hash backfill, favicon
  collapse) keep their own short transactions and are flushed right after.
  The pre-Empty-Trash backup moved to `Mutation::prepare` (before the
  transaction).
- **Replay rules as implemented:** duplicate `(origin, hlc)` ignored; every
  new row is stored with its original origin/HLC (forwarding) and advances the
  cursor and the local HLC; a purged entity drops the row whatever its HLC (a
  purge is final; the "hlc ≥" comparison would have resurrected late edits);
  registers win by HLC; no revision preconditions (revision still +1);
  missing dependency (board, parent, asset) → `pending_changes`, retried in HLC
  order until no progress; a card or board placed onto a purged board is
  purged too; a board move forming a cycle keeps the local parent; an asset row
  collected by local GC before its card arrived is restored from `changes`;
  asset file names are validated (single safe component) before a row is
  accepted.
- **Conflict copy:** when a note body change and the local body are
  *concurrent* (neither's `prev` clock is the other; different devices) and the
  plain text differs, the losing text becomes a new note to the right of the
  original, headed "Conflict copy". The id is derived from the losing change,
  so every device creates the same copy; the copy is journaled. The ADR's
  5-minute window was not used: causal `prev` detects concurrency exactly, and
  a window would silently drop real offline conflicts older than 5 minutes
  while flagging sequential edits made within 5 minutes.
- **Not journaled / not synced:** `LOCAL_ONLY_TABLES` (device identity,
  locators, viewport, device names, sync bookkeeping), `workspaces` (each
  device owns its row), `favicon_cache` (per-device fetch cache), idempotency
  receipts (`mutation_receipts`, `operation_receipts`: an agent retry is
  deduplicated on the device it hit), asset row deletions (GC is per replica),
  the search index and `change_seq` (derived). Everything else a mutation can
  create is expressible and synced: boards, all seven card kinds, assets
  (metadata; blobs by `sha256`), board covers, quick-board references.
- **Backfill:** pre-journal data gets one `snapshot` row per entity (trashed
  ones included) at the first start after 0025, in `db::open_and_bootstrap`
  (after the device identity is final), guarded by
  `local_meta.journal_snapshot_done`.
- **Blobs:** `journal::missing_blobs` lists the `sha256` of asset rows whose
  file is absent; loads never read files, so such cards render (the protocol
  handler returns 404 until the blob arrives).
- **UI notification:** the 0023 triggers bump `change_seq` for replayed
  writes, but replay commits on the app's own writer, so the P1.6 poll (which
  requires `data_version` to move) does not reload; `sync_apply_changes`
  emits `sync-applied` with the touched board ids for the frontend (not wired
  yet).
- **Open for S3:** the transport (relay vs LAN vs shared folder); cursor
  semantics require per-origin prefix delivery; journal compaction.
