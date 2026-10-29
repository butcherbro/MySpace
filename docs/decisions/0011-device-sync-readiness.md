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
  the 6-digit code offline; a PAKE (SPAKE2/CPace) would close it. Closed by
  the 2026-10-29 amendment (SPAKE2, pairing protocol 2).
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

## Amendment 2026-10-28: forward-compatible replay (accepted, implemented)

**Problem.** Replay stores a received row in `changes` and advances the
origin's cursor before applying it (Decision 3, steps 1–2), so the peer never
sends it again. Until this amendment a row this build could not interpret —
an entity kind without registers, a card kind the registry lacks, a payload
version other than `IMAGE_VERSION` — was counted `rejected` together with
genuinely broken payloads. The image stayed in `changes`, but nothing replayed
it after an upgrade. ADR-0013 shipped with two one-off migration steps (0027,
0028) that re-queue connector and group rows from `changes`; every new kind
would have needed another such step, and in a mixed pair (one device on
0.2.6, the other on the next release) the arrows and groups made on the new
device reached the old one only through those steps.

**Decision: defer what is unknown, reject only what is broken.**

- `pending_changes.reason` (migration 0030, additive). `NULL` is the ordinary
  park for a missing dependency: retried after every batch, `attempts`
  counts. A non-`NULL` reason — `entity_kind`, `card_kind`, `register`,
  `payload_version` — means "deferred for a newer build": not retried inside
  a batch, `attempts` never moves, nothing ages the row out.
- The rule in `apply_row`: a payload that does not decode, or a known kind
  whose required fields are missing or malformed, is `Rejected`, and so is a
  payload version OLDER than `IMAGE_VERSION` — a row that is broken on this
  build is broken on every future build. A payload that decodes
  but names something this build does not have is `Deferred`. A tombstone of
  an unknown entity kind is deferred like its create, so the retry replays
  create-then-purge in HLC order; a tombstone of a card of an unknown card
  kind carries no state and purges at once, and the deferred create is
  dropped as purged on retry.
- Unknown register. An image from a newer build carries the clock of every
  register of its entity, including the ones this build lacks. Parking such
  rows whole would stall sync between versions entirely, so the known
  registers apply as before and the row is additionally deferred with reason
  `register`. On the retry after the upgrade the known registers are
  equal-clock (superseded) and only the new one wins: LWW stays idempotent.
- Retry trigger: a capabilities fingerprint — `IMAGE_VERSION`, every entity
  kind with its registers, every card kind, the schema version — is kept in
  `local_meta.sync_capabilities`. A replay that runs under a different
  fingerprint first releases every deferred row (clears its reason); the rows
  then take the normal passes in HLC order, and whatever is still unknown is
  deferred again. Startup already replays `pending_changes` whenever it is
  non-empty, so the retry happens at the first start of the new build, with
  no peer page needed.
- Migration steps 0027/0028 stay: they serve databases written by 0.2.6,
  which rejected instead of deferring.

**A column added to an existing register (`group_id`).** ADR-0013 put
`group_id` into the card's `place` register without a new register or a new
`IMAGE_VERSION`. A `place` written by 0.2.6 has no `group_id` key, and until
now it applied as `NULL`: moving a member on the old device ungrouped it
everywhere. Rule from now on: a key absent from an image means "the writer
does not know this column", never "null". `card_place` keeps three states for
`group_id` (absent / null / value); an absent key leaves the stored column
untouched on update and writes `NULL` on insert. Compaction gets the matching
clause in R1: a card row whose state lacks the `group_id` key never dominates
a row that has it, so a device bootstrapped from a compacted journal still
creates the card inside its group. Consequence accepted: a member moved on a
0.2.6 device can sit outside its group's frame on the new device until it is
moved again; the membership survives, which is what the stored-membership
decision asks for (a frame never captures or releases a card by position).
Any future column added to an existing register follows the same rule, or
bumps `IMAGE_VERSION`, which an older build then defers with reason
`payload_version`.

**Known gaps.**

- The compaction clause runs only where the new build compacts. A 0.2.6
  device still deletes the row carrying `group_id` when its own newer
  `place` row dominates it, so a device bootstrapped from a journal that the
  0.2.6 device compacted creates the card outside its group. The window
  closes when that device updates and moves the card once.
- A known row that depends on a deferred one (a connector whose endpoint is
  a card of an unknown kind) fails its foreign key and becomes an ordinary
  parked row: retried after every batch, `attempts` growing, until the
  update releases the row it waits for. `attempts` has no limit today, so
  nothing is lost; the retries are wasted work only.
- `pending_changes` is still not compacted. A long mixed-version period after
  a release that adds a register leaves one deferred row per received change
  on the old device until it updates. If that ever matters, R1 over
  `pending_changes` per entity is the fix.
- The dev build and the installed build share one database; the fingerprint
  differs whenever the dev build knows a kind the release does not, so each
  switch between them releases the deferred rows once. One pass over a small
  table; harmless.
- `report.pending` and the `pending_count` of `sync_status` include deferred
  rows, so on the older device of a mixed pair the number does not reach
  zero until it updates. The UI does not show it yet.

**Tests** (`src-tauri/tests/sync_replay.rs`): an unknown entity kind is
deferred, its cursor advances and its attempts stay at one across batches; a
deferred row applies at the first start of a build that knows its kind; an
invalid payload is still rejected; a newer payload version is deferred; an
unknown card kind is deferred and its later tombstone still purges it; an
unknown register applies the known ones and waits for the rest; a `place`
without `group_id` keeps the membership; compaction keeps the row that carries
the membership and a bootstrapped replica has it.

## Amendment 2026-10-29: SPAKE2 pairing (accepted, implemented)

**Problem.** The 2026-09 pairing sent `HMAC(code, fp_B ‖ fp_A)`. An active
man-in-the-middle terminating B's TLS (B accepts any certificate on
`GET /pair`; "Add by address" has no pin) received that proof, brute-forced
the 10^6 codes offline in about a second, answered within B's 30 s timeout,
and B pinned the attacker's fingerprint as A.

**Decision.** Pairing protocol 2 replaces the code-keyed HMAC with SPAKE2
(BoringSSL's implementation in `aws-lc-sys`, already in the tree as the
aws-lc-rs backend; no new crate, `sync/spake2.rs` is a small safe wrapper).
A (showing the code) is Alice, B (typing it) is Bob; the SPAKE2 names are the
two certificate fingerprints as seen on the TLS channel, the password is the
code, the output is a 64-byte key K (wiped from memory on drop, like the code
when it is burnt). Codes have 8 digits instead of 6, for the version gate
below.

```text
B → A  GET  /pair        → {deviceId, name, fingerprint, protocol: 1, pairing: 2}
B → A  POST /pair/begin  {msg: msg_B}  → {msg: msg_A, session}
B → A  POST /pair        {session, deviceId, name, fingerprint, port,
                          proof = HMAC-SHA256(K, fp_B ‖ fp_A)}
A → B  {deviceId, name, fingerprint, port, proof = HMAC-SHA256(K, fp_A ‖ fp_B)}
```

A stores B only after a valid `proof_B`; B stores A only after a valid
`proof_A`. Between two protocol-2 devices, a relay with its own certificates
derives a different K on each side, and an attacker who runs SPAKE2 itself
gets one online guess per session; the transcript gives nothing to test
offline.

**Attempt accounting.** Each `POST /pair/begin` uses up one of the code's 5
attempts when it starts, confirmed or not (a SPAKE2 failure on A's own side
is a 500 and costs nothing), so a session is at most one guess
and at most 5 sessions exist per code. A session lives 60 s, belongs to the
client certificate that began it, is confirmed at most once, and disappears
with the code (new code, cancel, expiry, success, burn). A begin after 5 is
refused (429); a wrong proof on the last attempt burns the code (429). An
undecodable message still costs its attempt (400). An unknown or expired
session, or one begun under another client certificate, is 409. B words a
403, and a 429 on begin (attempts used up by sessions it did not run), as
"wrong code, or another device is trying to pair — make a new code".

**Version gate, no fallback.** Mixed versions must not pair, because an old
typing device sends `HMAC(code, fp_B ‖ fp_M)` to whoever terminates its TLS:
a man-in-the-middle brute-forces the code offline, then runs a correct
SPAKE2 with the new device (one attempt) and is stored. 426 never fires in
that attack, since the attacker speaks protocol 2 to A. Hence 8-digit codes:
builds before protocol 2 accept exactly 6 digits and refuse an 8-digit code
before computing any HMAC. A new build refuses a 6-digit code locally ("that
is a 6-digit code from an older MySpace; update MySpace on the other
device"). On the wire, `GET /pair` advertises `pairing: 2`
(`PeerInfo` accepts unknown fields, so older clients ignore it). A new client
refuses a server without it ("the other device runs an older MySpace; update
MySpace on the other device to pair") and never falls back to the HMAC
exchange, which an attacker could otherwise force by hiding the field. A new
server answers the old `POST /pair` body (no `session`) with 426 and an
`error` text the old client shows as is; 403/410 are avoided because the old
client maps them to "wrong code" / "no code shown". Already paired devices are
unaffected: `/v1` and `PROTOCOL_VERSION = 1` are unchanged. Two old builds
pairing with each other keep the old weakness.

**Tests.** `sync/spake2.rs` (same code → same key, different code or names →
different keys, garbage refused), `sync/pairing.rs` (session accounting) and
`src-tauri/tests/sync_lan.rs`: pairing in both directions, the `pairing: 2`
advert, a begin without confirm and an undecodable message each count, a
session cannot be confirmed under another certificate, a relay that does not
know the code completes neither side (relaying, or guessing on both sides),
an old client gets 426, a new client refuses a server without `pairing: 2`
and a 6-digit code. Session expiry is a unit test in `pairing.rs`.

**Not covered.** The private key still lives in `local_meta` (separate
backlog item). Windows linking of the `aws-lc-sys` SPAKE2 symbols is checked
by CI only (the bindings for `x86_64-pc-windows-msvc` export them).
