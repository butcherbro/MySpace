# Current State — V1

> **This file is the single source of truth for status.** Detailed evidence lives
> in `docs/testing/v1-stabilization-report.md`; backlog lives in `tasks/todo.md`;
> rules and history live in `tasks/lessons.md` and `docs/decisions/`.
>
> Nothing here is a claim without a run behind it. When status changes, the
> evidence in the report is refreshed in the same commit.

## 2026-09-24 update (read this first)

The stabilization branch is merged into `main`; the status below the next
heading describes 2026-09-13 and is kept for history. Current work is on
`claude/awesome-goodall-4tfsko`: the architecture audit
(`docs/audits/2026-09-24-architecture-audit.md`) and its P0 fixes are done with
every gate green (cargo fmt / clippy `-D warnings` / test, vitest 451, e2e 57).
P1 is complete (P1.1–P1.9, 2026-09-24): single-writer `Workspace`,
content-addressed assets + backup 2.0 with restore, card-kind registry,
FTS5 search, receipts + Rust plain-text codec, targeted invalidation,
corrupt-document state + startup recovery, virtualised canvas, CI audits.
Details per item in `docs/plans/2026-09-24-p1-scalability-and-sync-readiness.md`
(status paragraphs) and `tasks/todo.md`. P1.1 (database off the main thread) was the first: `src-tauri/src/app/workspace.rs`
is the only owner of SQLite connections, every write is a `domain::Mutation`
applied on one writer thread, every Tauri command is `async`, and the MCP
binary goes through the same handle. Next is P1.2 ∥ P1.3 per
`docs/plans/2026-09-24-p1-scalability-and-sync-readiness.md`, shaped for
device sync (ADR-0011, accepted). Backlog status lives in
`tasks/todo.md` → «Архитектурный аудит 2026-09-24».

## Where V1 stands

The stabilization plan `docs/plans/2026-09-11-v1-stabilization-and-debt-paydown.md`
is complete through Task 18 plus the SECURITY-HARDENING checkpoint, on branch
`codex/v1-stabilization` (61 commits, clean worktree). **Automated gates are
green** at `4292e3a`:

- `npm run check` — 330 tests, 54 files; lint and typecheck clean
- `npm run test:e2e` — 39 passed, and a test now fails on any unexpected
  browser runtime error
- `npm run build` — ok; main chunk 893 kB (gzip 274 kB)
- `npm audit` — 0 vulnerabilities
- `cargo test` — 173 passed, 0 failed; `cargo clippy --all-targets -D warnings`
  and `cargo fmt --check` clean

**Not yet done: packaged macOS acceptance.** Everything above runs headless
against an in-memory mock or a temporary database. The application itself —
bookmark durability, the CSP, the close-flush path, the visual shell — has not
been verified in a packaged build, and no automated gate can stand in for that.
That is Task 20, and it needs a person at the app.

## Architecture decisions that are settled

- Tauri 2 + React 19 + TypeScript + Vite, React Flow behind `CanvasAdapter`,
  SQLite via `rusqlite`. The frontend generates ids (UUIDv7); IDs stay an input
  to every `create_*` — except `duplicate_board`'s copied descendants, which the
  backend generates inside its one recursive-copy transaction (ADR-0009).
- `documentJson` is authoritative for note text; plain text is derived.
- Every mutation carries an optimistic `revision` and is rejected when stale.
- SQLite is the authority for durable ownership; `assets/` is a managed
  projection. See `docs/decisions/0001-v1-scope.md` and `0002-dependency-audit.md`.
- Folder shortcuts use plain macOS bookmarks (ADR-0006) — security-scoped
  creation fails outside the App Sandbox, which this app does not use.
- A mixed selection moves as one atomic backend command (ADR-0007).
- Favicon identity is the stored bytes (ADR-0008).
- Search excerpts are Unicode-safe: folded positions map back to original
  characters, never byte offsets across strings.
- Pending drafts are flushed before the window closes (timeout, then a dialog
  offering to close without saving).
- The production CSP is derived from what the app loads; `devCsp` is looser for
  the Vite dev loop. Both live in `src-tauri/tauri.conf.json`.
- `App.tsx` is composition and command orchestration; each controller owns one
  state machine under `src/app/`, `src/canvas/`, `src/navigation/`,
  `src/search/`, `src/state/`.
- `workspace_repository` is a re-export facade over seven aggregate modules under
  `src-tauri/src/repositories/`; 187 call sites are unchanged.
- Board shortcuts (`board_shortcut` card kind, todo.md №17, ADR-0010): an alias
  that points at a board without owning it — identity (title/color/symbol/cover)
  is read live via a LEFT JOIN on the target board, never copied, and a
  gone/trashed target projects as a broken shortcut (`target: null`) instead of
  failing the read. Trashing a board cascades to every shortcut into its subtree
  under the same batch id; not indexed by search (a board's own title is already
  the canonical hit).

## What is open

Correctness debt and wishlist are kept apart, with owners, in
`docs/testing/v1-stabilization-report.md` → "Residual debt". In short: packaged
acceptance and the architect's CSP confirmation are open and owned by the user;
the favicon-source-URL question in ADR-0008 is deferred by the user's
instruction; bundle splitting and board duplication are wishlist, not debt.

## Resuming work

- Worktree: `/Users/bro/Projects/MySpace/.wt-v1-stabilization` (nested inside the
  workspace; run commands only from there).
- Session handoff and environment notes: `.continue-here.md`.
- Do not launch the application from the main checkout: it still contains the old
  asset GC that deleted File Card assets.
- Changes reach `main` as one package when the branch is merged — not by
  cherry-picking, so the data-integrity fixes stay independently reviewable.
