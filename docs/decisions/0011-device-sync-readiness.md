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

**S3 implemented 2026-09-24: LAN transport**, symmetric peers, pull-based,
no server. Migration **0026** (`sync_peers`, local-only), module
`src-tauri/src/sync/{tls,pairing,peers,server,peer_client,discovery,lan}.rs`,
tests `src-tauri/tests/sync_lan.rs`, UI `src/sync/` (Devices dialog, top-bar
pill), README "Sync (LAN)".

- **Identity:** per device a self-signed ECDSA P-256 certificate (`rcgen`),
  minted on first start of the service and stored in `local_meta`
  (`sync_tls_cert_pem`, `sync_tls_key_pem`, `sync_tls_device_id`; a new
  `device_id` after a machine change mints a new certificate). The SHA-256 of
  the DER is the transport identity; peers are pinned by it, no CA.
- **Wire:** HTTPS, TLS 1.3 only, mutual TLS (hyper 1 + tokio-rustls server,
  reqwest client with a pinning `ServerCertVerifier`), JSON. Server binds
  `0.0.0.0:0`. The handshake requires a client certificate and checks its
  signature; authorization is per request: `X-MySpace-Device` must name a
  `sync_peers` row whose fingerprint equals the presented certificate's
  (403 otherwise), because `/pair` has to accept a device that is not paired
  yet. Endpoints: `GET /v1/info`, `GET /v1/cursors`, `POST /v1/changes`
  (`{cursors, limit}` → `{rows, next}`, `journal::changes_since`, per-origin
  HLC order), `GET /v1/blobs/{sha256}`; plus `POST /v1/poke` (no body: "pull
  from me now", so a write propagates in ~0.5 s instead of on the peer's
  5-second tick) and `GET`/`POST /pair`. A relay later reuses the same four
  data endpoints; the poke becomes its notification channel.
- **Pairing:** A shows a 6-digit code (5 min, 5 attempts). B, having seen A's
  certificate on the TLS channel (`GET /pair`), sends `{deviceId, name,
  fingerprint, proof = HMAC-SHA256(code, fp_B ‖ fp_A), port}`; A checks the
  fingerprint against the presented client certificate and the proof, stores
  B, burns the code and answers with `HMAC(code, fp_A ‖ fp_B)`, which B
  verifies before storing A. Deviation: the messages also carry the server
  port so each side can reach the other without mDNS. Known weakness: the
  proof lets an active man-in-the-middle during the pairing minute brute-force
  the 6-digit code offline; a PAKE (SPAKE2/CPace) would close it.
- **Discovery:** `mdns-sd`, `_myspace-sync._tcp.local.` with TXT `device_id`,
  `name`, `fp`; re-advertised on rename. Failure → state "discovery
  unavailable", pairing by `host:port` still works; each peer's last working
  address is stored (`sync_peers.last_address`, an extra column).
- **Loop:** one tokio task, one pass at a time. Pass = for each paired peer
  with an address (mDNS or last known; backoff up to 60 s after failures
  unless forced): `/v1/info` identity check → pull pages until `next` is empty
  → apply each page through the funnel (`Mutation::ApplySyncChanges`) →
  fetch `missing_blobs` from that peer (streamed, SHA-256 verified, placed
  atomically under every asset row's file name) → `sync_peers.last_sync_at`
  or `last_error`. Triggers: start, 5 s tick, 500 ms after a local journaled
  write (`Workspace::local_writes`, a `tokio::sync::Notify` signalled by the
  writer thread after a journaled commit; the pass also pokes the peers), a
  journaled write by another process on the same database (the MCP server:
  while at least one peer is paired, a pooled reader compares this device's
  journal cursor every 500 ms with the cursor as of the last poke; a
  difference runs a poking pass), a peer's poke, pairing, `sync_now`. Replays
  do not signal, so no ping-pong.
- **Blob serving:** the server streams an asset file from disk in 64 KiB
  chunks with an exact `Content-Length`; a connection whose write makes no
  progress within the stall timeout is dropped.
- **Events:** `sync-applied` (touched board ids, plus boards showing a blob
  that just arrived) → the open board reloads through the same path as the
  external-change poll; `sync-state` `{peers: [{deviceId, name, online,
  discovered, lastSyncAt, lastError, lastAddress}], discovering,
  discoveryError, syncing, port, addresses}`.

## Amendment 2026-09-30: journal compaction (accepted, implemented; see deviations below)

**Problem (measured, release build, M3 Max).** Every journaled write stores a
full entity image, about 1.6 KiB on disk per change. 100 000 changes are
about 160 MB (75 % of the database), a fresh device replays them in about
50 s, and the journal never shrinks.

**Decision: dominance compaction, independent of peers.** Merging is
last-writer-wins per register and a missing entity is created from a full
image, so a row that another row of the same entity supersedes on every
register is never needed for convergence — not by a device that never synced,
one that was offline for months, or one reached through forwarding. No
per-peer state, no snapshot format, no wire change, no migration.

Rules, applied per entity on the writer thread in bounded chunks:

- **R1.** Delete row R if another row R' of the same entity has
  `clocks[r] >= R.clocks[r]` for every register.
- **R2.** Never delete: purge rows; the newest row of each origin (the HLC
  high-water mark); for notes, the row whose HLC equals the current body
  clock in `entity_clocks`; for notes, a body-setting row whose `prev.body`
  came from another device, together with that prev row, while its wall age
  is under **G = 90 days**. R2 exists for the conflict-copy detector
  (`conflict_copy_plan`), which judges "sequential or concurrent" from the
  row that set the body and its one-hop `prev`.
- **R3.** For a purged entity, delete every row except its purge row, so the
  text of a purged note is not shipped to new devices. `purged` tombstones
  and `entity_clocks` are kept forever in this version.
- **R4.** Compaction is a local-only `Mutation` (`CompactJournal`). It runs
  at startup maintenance and after a sync pass that received rows, with a
  watermark in `local_meta`. The first compaction of an existing database is
  preceded by a backup snapshot. After a compaction that frees more than
  25 % of the file, `VACUUM` runs once at the next startup.

**Consequences accepted.**

- A device that returns after more than G may show extra "Conflict copy"
  notes; no text is lost.
- Fewer conflict copies than before: intermediate rows of a concurrent run
  no longer each produce their own copy.
- Delivery is no longer a plain prefix of the journal. Replay must therefore
  skip a row whose HLC is not above the cursor of its origin (dedupe can no
  longer rely on the row being present), and must retry parked rows to a
  fixpoint instead of a fixed number of passes, because retained rows lose
  creation order.

**Rejected.** Dropping superseded rows at write time (breaks conflict
lineage and puts a DELETE on the write path); dropping only what every known
peer has passed (no per-peer state exists, one offline peer blocks it
forever, and a new peer still needs a bootstrap); a separate snapshot format
(the dominance set already is the snapshot).

**Required tests.** Property test: three replicas with random operations,
exchange order, batch sizes and compaction points converge to the same state
as the uncompacted run, modulo conflict copies. A replica bootstrapped from a
compacted journal equals one built from the full journal. Lineage cases: two
or more autosaves then sync back give zero copies; a concurrent edit whose
head row is a move still gives exactly one copy. Compaction is idempotent;
no resurrection after purge; boards nested deeper than the old retry cap.

### Deviations in the implementation (2026-09-30)

- **Dedupe by floor, not by cursor.** Replay drops a row whose HLC is at or
  below its origin's floor: the highest HLC compaction deleted here, per
  origin, in `local_meta`. A cursor bound would drop rows legitimately
  delivered out of order (`out_of_order_delivery_parks_and_converges`).
- **R3 applies only to cards with a purge row of their own.** Cards purged by
  a board cascade, and purged boards, keep all their rows, so their texts
  still reach new devices. The head row of a purged card lives until its
  origin writes again (R2).
- **Placement.** Walking an entity's rows in HLC order, the place in effect
  is the image with the highest `place` clock (LWW, as in replay). Every row
  that changes a card's board or a board's parent is kept, including rows
  older than the oldest otherwise kept one.
- **Creation.** The oldest row of every board and asset is always kept, so
  dependent rows never precede their target's creation by HLC during a
  bootstrap. Independently, `conflict_copy_plan` follows `prev.body` through
  the journal up to 32 hops, not one, before calling two edits concurrent.

### Known gaps

- Replay without compaction depends on delivery order when a board purge
  races a move of its content (seed 179). The property test skips seeds that
  fail without compaction too.
- Compaction does not look at `pending_changes`.
- A broken `prev.body` chain (a row compacted away, not yet delivered, past
  the R2 grace, or held only in `pending_changes`) makes an edit look
  concurrent and yields an extra conflict copy. No text is lost.
- The copy id is deterministic, and any device that judges two edits
  concurrent creates the copy. A device on a pre-compaction build keeps
  creating those copies for everyone until it updates.
- If the backup before the first compaction fails, it is retried on every
  sync pass.
- Replay refuses a board move into a cycle without advancing its clock,
  while compaction treats the move as applied (theoretical).
