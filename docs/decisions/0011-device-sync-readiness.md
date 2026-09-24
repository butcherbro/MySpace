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
