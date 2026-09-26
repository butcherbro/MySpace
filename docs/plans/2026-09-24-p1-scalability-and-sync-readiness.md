# Plan — P1: scalability, integrity holes, sync readiness

- **Date:** 2026-09-24
- **Inputs:** `docs/audits/2026-09-24-architecture-audit.md` (risks, load modes,
  roadmap), ADR-0011 (device sync direction, accepted).
- **Status of P0:** done on `claude/awesome-goodall-4tfsko` (7 commits, all
  gates green). This plan is what comes next, in execution order.
- **Working rules:** one architect session plans, reviews and integrates;
  small bounded tasks go to worker agents with an explicit file list. Agents
  never run `git stash`, `git checkout`, `git reset` or commit; the architect
  commits after gates (`npm run check`, e2e, `cargo fmt --check`,
  `cargo clippy --all-targets -D warnings`, `cargo test`).
- **Decisions already taken (do not reopen):** restore into a trashed parent
  is refused, not cascaded; asset storage becomes content-addressed (sha256),
  not APFS clonefile; sync is an operation journal with HLC + LWW (ADR-0011),
  built after P1, on the mutation funnel P1.1 introduces.

Every P1 task below states how it serves sync, because the user's rule is:
"everything we set up now must be shaped for the sync we planned".

---

## P1.1 — Database off the main thread; one mutation funnel

**Status: done 2026-09-24.** Implemented as `src-tauri/src/app/workspace.rs`
(`Workspace`: writer thread + 2-connection read pool, `apply`/`read`,
blocking variants for MCP and tests, `inspect_writer` for `data_version`),
`src-tauri/src/domain/mutation.rs` (`Mutation` / `MutationOutcome`), every
command module `async`, MCP binary on `Workspace::open_existing`, all write
transactions `BEGIN IMMEDIATE` with the guards inside (`tests/write_transactions.rs`),
startup maintenance deferred 2 s onto the writer thread, enrichment split into
`plan_embed_enrichment` (reader + network) and `Mutation::ApplyEmbedMetadata`
(writer, one transaction). Acceptance test: `tests/workspace_actor.rs`.
Known leftovers: enrichment holds one pooled reader for the fetch duration
(TODO in `link_metadata.rs`); `import_asset` check-then-copy-then-insert stays
outside the lock by design (file I/O never runs on the writer).

**Why first.** Sync commands (K1 in the audit): every command is a sync
`#[tauri::command]` and therefore runs on the main thread under one
`Mutex<Connection>`. Every later task (FTS, background backup, journal)
needs DB work to be off the UI thread and to pass through one place.

**Target shape.**

```
Tauri command (async fn)  ──►  Workspace handle (Clone, Send)
MCP adapter               ──►      .read(|conn| …)   → read pool (2 conns)
                                    .apply(Mutation)  → writer thread (1 conn, queue)
                                                        └─ transaction IMMEDIATE
                                                           ├─ domain fn (existing code)
                                                           ├─ (later) journal row      ← ADR-0011 hook
                                                           └─ receipt { revisions… }
```

**Steps.**
1. `src-tauri/src/app/workspace.rs` (new): `Workspace` struct holding a
   writer `std::thread` with an `mpsc` channel of boxed jobs
   `FnOnce(&mut Connection) -> Result<…>`, plus a small read pool (two
   connections, `Mutex<Vec<Connection>>`). Both use the existing pragmas.
   `apply()` returns a `oneshot` future; commands become `async fn` and
   `.await` it. Reads go through `spawn_blocking` on a read connection.
2. Every write transaction becomes `IMMEDIATE`; the check-then-act queries
   that today run outside the transaction (create_child_board,
   move_card_to_board, add_quick_board, create_link_batch replay check,
   create_image_card) move inside it. One helper `with_write_tx` owns retry
   on `SQLITE_BUSY` (bounded, jittered).
3. `enrich_embed_metadata` keeps its own connection for the network phase
   but applies the result through the writer.
4. `Mutation` enum in `src-tauri/src/domain/mutation.rs`: one variant per
   existing mutating command, carrying the existing `*Input` structs. The
   writer matches on it and calls the existing domain/repository function.
   Tauri commands and the MCP adapter construct `Mutation`s; they no longer
   call repositories directly. This is the journal hook for sync (S1).
5. Startup work (favicon collapse, asset GC, backup) moves to a background
   task after the window is shown; `empty_trash` runs its pre-snapshot on
   the writer thread, not the UI thread.
6. Telemetry: the `instrument` wrapper measures queue wait separately from
   execution (`queue_ms`, `exec_ms`).

**Acceptance.** `cargo test` green; a test proves two concurrent writers
(writer thread + a second connection) never surface `database is locked`
to the caller; UI stays responsive during a 5 s `qlmanage` (manual check);
no command file references `workspace_repository::` directly.

**Sync tie-in.** `Mutation` is the journal's payload vocabulary; the writer
thread is where journal rows will be appended in the same transaction.

Owner: architect (structure) + one agent per command module for the
mechanical conversion. Estimate: 3–5 days.

---

## P1.2 — Content-addressed assets and backup 2.0

**Status: done 2026-09-24.** Migration 0020 (`assets.sha256` + partial index),
hashing in every `stage_*`, dedup on import/clipboard/file/enrichment via
`find_asset_by_sha256`, `Mutation::HashExistingAssets` backfill queued at
startup, hard-linked snapshots with byte retention (`BACKUP_MAX_TOTAL_BYTES`),
`list_backups` / `request_restore` commands (restore marker applied on next
launch), "Backups…" dialog in the Trash drawer. Deviation: files still linked
from the live `assets/` dir are not counted against the byte limit (pruning
cannot free them). `collapse_favicon_duplicates` is retired, delete next release.

**Why.** K2 in the audit: every startup snapshot copies every asset, ten
snapshots keep ten copies. Sync needs blob identity by hash (ADR-0011 §4).

**Steps.**
1. Migration 0020: `assets.sha256 TEXT` (nullable, indexed); a one-time
   background job hashes existing files and fills it; new imports hash on
   write (`asset_service::stage_*`).
2. Import dedup by hash: an import whose hash already exists reuses the
   existing row (this retires `collapse_favicon_duplicates` at startup —
   keep it one more release as a no-op migration, then delete).
3. On-disk layout: keep `assets/<uuid>.<ext>` for now (no mass rename);
   hash is metadata. Moving files under `assets/<sha>/…` is optional later.
4. Backup 2.0 (`db/backup.rs`): snapshot the DB always; assets are
   hard-linked into the snapshot when on the same volume (falls back to
   copy), with `manifest.json` listing `{sha256, file_path}`; retention by
   total bytes (default 2 GB) and count; runs on a background thread after
   startup with a progress `tracing` line; `restore_from_backup` gets a
   Tauri command + a minimal dialog ("Restore from <date>").
5. Missing-asset report (P0.4) stays; a snapshot lists what it lacks.

**Acceptance.** Snapshot time on a 2 GB asset dir under 2 s on APFS;
disk usage of ten snapshots ≈ one copy of assets; restore round-trip test
with hard-linked assets; hash present for every asset after migration.

**Sync tie-in.** Blob exchange in S4 is "send me the hashes you lack".

Owner: agent (migration + hashing), agent (backup), architect (restore UI
wiring). Estimate: 2–3 days.

---

## P1.3 — Card-kind registry on the backend; drop `CHECK(kind IN …)`

**Status: done 2026-09-24.** `domain/card_kind.rs` (enum, `sql_in_list`,
`CardKindHandler`), `domain/kinds/*` (one handler per kind, `DetailTable`
codec: `to_payload`/`from_payload` round-trip tested per kind), migration 0021
(last `cards` rebuild, CHECKs replaced by `Frame::validate`), generic code
iterates the registry; frontend `src/cards/card-kinds.ts` is the single list.
Deviations: `search_rows` returns ranked `SearchHit`s; `list_trash` labels and
the board-semantics branches in trash stay kind-specific by design.

**Why.** K3: adding a kind means rebuilding `cards` and touching ~15 code
sites, several of which are SQL string literals.

**Steps.**
1. `domain/card_kind.rs`: `enum CardKind` with `FromStr`/`as_str`,
   `CardKind::LEAF` and `ALL` slices, and `sql_in_list(kinds)` used by every
   `kind IN (…)` today (`trash_service`, `cards.rs` ×4, `empty_trash`).
2. Migration 0021: the last `cards` rebuild — remove the `CHECK(kind IN …)`
   and the size CHECKs (`width/height`) in favour of Rust validation
   (`Frame::validate`), recreate all indexes including the partial
   `idx_cards_trashed`, run `foreign_key_check` (P0.2 does this
   automatically).
3. `trait CardKindHandler { fn load_many(conn, board_id, unsorted) ->
   Vec<CardDto>; fn load_one; fn copy_detail(tx, from, to); fn
   delete_details(tx, ids); fn search_rows(conn) -> …; fn asset_refs() ->
   &[(&str table, &str column)]; fn to_payload(conn, id) -> Value; fn
   from_payload(tx, id, Value) }`. One impl per kind, registered in a
   static table. `load_cards`, `duplicate_board`, `empty_trash`,
   `collect_orphaned_assets`, `search_workspace` iterate the registry.
4. Frontend: `card-registry.tsx` gains `clipboard`/`trash`/`paste` entries so
   `TrashItem` kinds, `PasteCardSpec` and `CanvasCardKind` derive from one
   list.

**Acceptance.** Adding a throwaway `test_kind` in a test touches only the
new handler + one migration and passes every existing suite; no `kind IN ('`
literal remains outside `card_kind.rs`.

**Sync tie-in.** `to_payload`/`from_payload` are the journal codecs (S1).

Owner: architect (trait + registry), agents (one per kind). Estimate: 3–4 days.

---

## P1.4 — FTS5 search

**Status: done 2026-09-24.** Trigger-maintained `search_index` (+
`search_index_keys` for O(1) row lookup), word-prefix MATCH with quoted
tokens, 200 candidates, existing ranking/excerpts kept. Deviations: no bm25
ordering (too slow when everything matches); substring fallback only for ≤3
character queries; file cards searchable.

Steps: migration 0022 creates `search_index(entity_id UNINDEXED, kind
UNINDEXED, board_id UNINDEXED, text)` as an FTS5 table with `unicode61`
tokenizer; the writer updates it inside each mutation that changes
searchable text (via `CardKindHandler::search_rows`); a one-time rebuild
job fills it; `search_workspace` queries FTS for candidate ids, then ranks
in Rust as today (title-before-body), then loads identities. Keep the
Unicode-safe excerpt code.

Acceptance: 50k-note fixture search under 30 ms; existing search tests
green; excerpts unchanged for existing cases.

Sync tie-in: the index is derived; it is rebuilt from journal replay, never
synced.

Owner: agent. Estimate: 1–2 days (after P1.1 and P1.3).

---

## P1.5 — Mutations return receipts; `plain_text` computed on the backend

**Status: done 2026-09-24.** Receipts in `models.rs`, revisions read back in
the write transaction, `domain/plain_text.rs` pinned by
`tests/fixtures/plain_text_cases.json` (mirrors the TS test), derived-text
fields removed from six input structs, frontend consumes receipts.

Steps: every `Mutation` returns `Receipt { revision(s), updated DTO where
cheap }`; frontend commands and the reducer stop computing `revision + 1`
(five sites); `plain_text`/`caption_plain_text`/`description_plain_text`
are derived in Rust from `document_json` (port `documentToPlainText`
semantics; TS keeps its copy only for instant local UI); MCP `add_links`
uses the same codec.

Acceptance: grep finds no `revision + 1` in `src/`; a Rust test pins the
plain-text codec against the TS fixtures.

Sync tie-in: replayed journal entries produce identical derived columns on
every device because derivation lives in one place.

Owner: agent (Rust codec + receipts), agent (frontend). Estimate: 2 days.

---

## P1.6 — Targeted invalidation instead of full reload

**Status: done 2026-09-24.** Trigger-maintained `boards.change_seq`
(cards, all detail tables, board metadata; parent and shortcut holders bumped
too); `get_board_change_seq(board_id) -> { dataVersion, changeSeq }` on the
writer connection; the poll reloads only when both changed.

Steps: `boards.change_seq INTEGER` bumped by the writer for the board(s) a
mutation touches (and its parent for portal counts); `get_data_version`
becomes `get_board_change_seq(board_id)`; the frontend polls that (or
receives a Tauri event from the writer) and reloads only when its own
board changed; the reducer's same-board merge (P0 fix) keeps editing and
selection.

Acceptance: an enrichment on board A while editing on board B causes no
reload of B; agent writes to the open board refresh it without closing the
editor.

Sync tie-in: incoming journal entries bump `change_seq` the same way, so
the UI refresh path is identical for local, agent and remote writes.

Owner: agent. Estimate: 1 day (after P1.1).

---

## P1.7 — Corrupt data as an explicit state; recovery dialog

**Status: done 2026-09-24.** Note/image/embed DTOs carry `corrupt` (empty
doc + stored plain text, `warn` with `error_code = "corrupt_document"`);
text writes over a corrupt row need `acknowledgeCorrupt`. Damaged cards show
the recovered text statically, never autosave, and offer Repair. A database
that fails to open starts the app in recovery mode (`get_startup_failure`,
no `Workspace` managed; the frontend `StartupGate` renders only the restore
dialog). `tests/corrupt_documents.rs`, `tests/e2e/corrupt-note.spec.ts`.

Steps: `document_json` parse failure yields `CardDto::Note { corrupt:
true, documentJson: null }` (never silently `null`); the NoteCard renders a
"damaged, showing plain text" state and never autosaves over it; startup
DB open failure shows a dialog offering `restore_from_backup` (P1.2) with
the newest validated snapshot.

Owner: agent. Estimate: 1 day.

---

## P1.8 — Canvas cost per card

**Status: done 2026-09-24.** `onlyRenderVisibleElements`, static Tiptap HTML
for idle notes/captions/descriptions (editor mounts only for the edited
card, caret placed at the click point), per-card node rebuilds
(`canvas-mapping.ts`), memoised card components. 1 000-note board: first
paint 3.5 s → ~0.7 s in the container; one update re-renders one card.
`tests/e2e/dense-board.spec.ts` guards budgets.

Steps: React Flow `onlyRenderVisibleElements`; NoteCard renders static
HTML (Tiptap `generateHTML`) when not editing and mounts the editor only
for `editingCardId`; replace the O(N) `cardsKey` string with a per-card
memo keyed by `(id, revision, frame, zIndex)`; dense-board budget test
(1 000 cards, first paint under 500 ms in the e2e harness).

Owner: agent. Estimate: 2 days.

---

## P1.9 — CI hygiene

**Status: done 2026-09-24.** `security-audit` job (cargo audit + npm audit),
Linux `cargo fmt/clippy/test` job, Dependabot (npm, cargo, actions).
`rustls` bumped to 0.23.45 for RUSTSEC-2026-0285; remaining warnings are
unmaintained/unsound transitive crates from Tauri/GTK (tracked by Dependabot).

`cargo audit` (or `cargo deny`) and `npm audit --audit-level=high` as CI
steps; Dependabot config for npm and cargo; a Linux job that runs
`cargo test` for the non-macOS crate parts (P0 made clippy pass on Linux).

Owner: agent. Estimate: 0.5 day.

---

## S — Sync (after P1; ADR-0011)

Not scheduled yet; listed so P1 reviews can check nothing blocks it.

- **S1 Journal.** Migration: `changes(seq PK, device_id, hlc, entity_kind,
  entity_id, op, payload_json, applied_at)`, `device(id, name, created_at)`,
  `purged(entity_id, hlc)`. The writer appends one row per `Mutation` in the
  same transaction (P1.1). `empty_trash` writes `purged` rows.
- **S2 HLC.** `domain/hlc.rs`: 64-bit wall-ms + 16-bit counter, monotonic
  per device, merged on receive. Property tests.
- **S3 Apply + convergence.** `apply_remote(change)` maps op → `Mutation`
  with LWW by `hlc` per row (frames/titles/colors/viewport), whole-document
  LWW for notes with a conflict copy for the loser, trash-wins-over-edit,
  purge tombstones. Tests: two in-memory DBs, random op interleavings,
  identical projections after exchange in any delivery order.
- **S4 LAN transport.** mDNS advertise/browse; HTTP over the local network;
  pairing by a 6-digit code exchanged once; per-pair key, TLS or Noise;
  endpoints `GET /changes?since=<seq>`, `GET /blob/<sha256>`, `POST /changes`.
  Tauri background task with a status indicator.
- **S5 Relay.** Small Rust service storing journals and blobs by hash;
  same endpoints; end-to-end encrypted payloads so the relay is dumb.
- **S6 Web viewer.** Read-only board rendering over the relay.

---

## Order and gating

1. P1.1 (blocks everything).
2. P1.2 and P1.3 in parallel (disjoint files: db/backup + asset_service vs
   domain/repositories).
3. P1.5, P1.6 after P1.1; P1.4 after P1.3.
4. P1.7, P1.8, P1.9 anytime.
5. Packaged acceptance on the user's Mac after P1.1 and after P1.2: these
   change threading and files on disk, which tests cannot fully prove.

Each task ships as its own commit series on the working branch with gates
green; `tasks/todo.md` is updated in the same commit.
