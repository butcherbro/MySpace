# V1 Stabilization and Technical Debt Paydown Implementation Plan

**Goal:** Stop confirmed asset loss, remove correctness races, restore trustworthy quality gates, and reduce the riskiest structural debt before any wishlist work continues.

**Architecture:** Treat SQLite as the authority for durable ownership and the asset directory as a managed projection. Fix data integrity first with regression tests, then repair async state boundaries and cross-board commands, then make the test harness fail on runtime errors. Defer broad refactoring until behavior is protected by green tests.

**Tech Stack:** Tauri 2, Rust 2021, rusqlite, React 19, TypeScript 5.8, React Flow 12, Vitest, Testing Library, Playwright, ESLint.

---

## Executor Contract

Work in this order. Do not start wishlist features while any P0/P1 task below is open.

- Implementation baseline: `5101f18` on `main`; start from the later `main` commit
  that contains this plan and verify that `5101f18` is its ancestor.
- Create a dedicated worktree/branch named `codex/v1-stabilization` from that plan commit.
- The saved project currently has unrelated uncommitted files. Do not reset, clean, stash, overwrite, or include them in commits.
- Never test destructive behavior against the live database under
  `/Users/bro/Library/Application Support/com.bro.myspace`.
- Use temporary databases and temporary asset directories in automated tests.
- Do not launch the current production app before Task 2 is complete: startup GC can delete File Card assets.
- Follow TDD for every behavior change: failing test, minimal fix, focused verification, commit.
- Commit one task at a time. Do not combine data recovery, refactoring, and feature changes.

### Architecture escalation protocol

When a checkpoint below says **ASK ARCHITECT**, stop before implementation and send the user this exact structure:

```text
Нужна консультация архитектора по checkpoint <ID>.
Что уже проверено: <facts and test output>.
Решение, которое предлагаю: <one concrete option>.
Альтернативы и последствия: <short comparison>.
Файлы/API, которые изменятся: <paths and contracts>.
```

The user will relay the question to the architect. Continue only after the answer is recorded in the task or plan.

---

## Phase 0: Protect User Data

### Task 1: Establish a safe baseline

**Files:**
- Read: `tasks/current-state.md`
- Read: `tasks/todo.md`
- Read: `.continue-here.md`
- Read: `src-tauri/src/domain/asset_service.rs`
- Read: `src-tauri/src/lib.rs`
- Do not modify product files in this task.

**Step 1: Create the isolated branch/worktree**

Use the Codex project worktree mechanism from `main` at `5101f18`. Confirm:

```bash
git status --short --branch
git rev-parse HEAD
```

Also run:

```bash
git merge-base --is-ancestor 5101f18 HEAD
```

Expected: branch `codex/v1-stabilization`, the ancestry command exits 0, and the worktree is clean.

**Step 2: Record the existing failures without fixing them**

Run:

```bash
npm run build
npm test
npm run lint
npm run test:e2e
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Expected baseline:

- build passes with an approximately 884 KB main JS chunk warning;
- Vitest has one failing `AppShell` assertion;
- ESLint crashes before linting with `scopeManager.addGlobals is not a function`;
- Playwright reports 38 passing tests but logs a `CanvasAdapter` page error;
- Rust tests pass;
- Clippy fails on four warnings promoted to errors;
- rustfmt passes.

**Step 3: Do not commit baseline artifacts**

No commit for this task.

---

### Task 2: Make asset GC understand every durable asset owner

**Priority:** P0. Complete before launching the app.

**Files:**
- Modify: `src-tauri/src/domain/asset_service.rs`
- Modify: `src-tauri/tests/asset_gc.rs`
- Read: `src-tauri/migrations/0002_assets.sql`
- Read: `src-tauri/migrations/0003_embed_links.sql`
- Read: `src-tauri/migrations/0009_board_cover.sql`
- Read: `src-tauri/migrations/0013_file_cards.sql`
- Read: `src-tauri/migrations/0015_file_card_preview_asset.sql`
- Read: `src-tauri/migrations/0016_favicon_cache.sql`

**Asset ownership contract:**

- Durable owners are `image_cards.asset_id`, `embed_cards.asset_id`,
  `embed_cards.favicon_asset_id`, `boards.cover_asset_id`,
  `file_cards.asset_id`, and `file_cards.preview_asset_id`.
- `favicon_cache` is an acceleration index, not an owner. A cache-only asset may be collected, but its cache row must be removed transactionally first.
- A foreign-key failure must occur before deleting the physical file.
- A missing physical orphan file counts as converged cleanup.

**Step 1: Add failing GC ownership tests**

Add focused tests to `src-tauri/tests/asset_gc.rs`:

```rust
#[test]
fn file_card_primary_asset_survives_gc() { /* create file card + asset; assert row and file survive */ }

#[test]
fn file_card_preview_asset_survives_gc() { /* set preview_asset_id; assert row and file survive */ }

#[test]
fn cache_only_favicon_is_collected_without_fk_failure() {
    /* insert asset + favicon_cache only; run GC; assert cache row, asset row and file are gone */
}

#[test]
fn live_favicon_reference_survives_gc() {
    /* embed_cards.favicon_asset_id owns the asset even when favicon_cache also references it */
}
```

Reuse test helpers; do not touch the live app directory.

**Step 2: Run the tests and confirm the current implementation fails**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test asset_gc -- --nocapture
```

Expected: File Card assets are selected as orphans and the cache-only case fails on its foreign key after the physical file is removed.

**Step 3: Replace the orphan query with `NOT EXISTS` ownership checks**

Do not use a growing `NOT IN (UNION ...)` list. Use explicit anti-joins so `NULL` cannot change semantics:

```sql
SELECT a.id, a.file_path
FROM assets a
WHERE NOT EXISTS (SELECT 1 FROM image_cards i WHERE i.asset_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM embed_cards e WHERE e.asset_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM embed_cards e WHERE e.favicon_asset_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM boards b WHERE b.cover_asset_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM file_cards f WHERE f.asset_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM file_cards f WHERE f.preview_asset_id = a.id)
```

**Step 4: Change deletion ordering**

For each candidate:

1. validate `file_path` with `is_safe_asset_name`;
2. start a transaction;
3. delete `favicon_cache` rows for the candidate;
4. delete the `assets` row; let unknown durable FKs block here;
5. commit;
6. remove the physical file; `NotFound` is success;
7. if filesystem deletion fails, return an error and leave a harmless untracked file rather than a live DB reference to missing bytes.

Do not delete the physical file before the database has proven that no durable owner exists.

**Step 5: Run focused and full Rust tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test asset_gc
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all tests pass; no referenced File Card file is deleted.

**Step 6: Commit**

```bash
git add src-tauri/src/domain/asset_service.rs src-tauri/tests/asset_gc.rs
git commit -m "fix: preserve file card assets during garbage collection"
```

---

### Task 3: Make startup GC observable and test startup convergence

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/domain/asset_service.rs`
- Modify: `src-tauri/tests/asset_gc.rs`

**Step 1: Add a failing test for repeated cleanup**

Add a test that runs GC twice after a cache-only orphan. Expected counts: first run `1`, second run `0`, both without error.

**Step 2: Stop silently swallowing startup GC failures**

Keep startup non-blocking, but report failures to stderr/logging with a stable prefix such as `asset-gc:`. Do not include note text, source paths, or other user content in the log.

**Step 3: Run tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test asset_gc
cargo test --manifest-path src-tauri/Cargo.toml
```

**Step 4: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/domain/asset_service.rs src-tauri/tests/asset_gc.rs
git commit -m "fix: make asset cleanup failures observable"
```

---

### Checkpoint DATA-RECOVERY: restore the already missing asset

**ASK ARCHITECT and require explicit user confirmation before writing live data.**

Facts already established:

- live DB schema version is 15;
- 12 File Card assets are misclassified by the old GC;
- one referenced file is missing;
- one validated backup contains that file:
  `/Users/bro/Library/Application Support/com.bro.myspace/backups/1789027600`;
- the backup manifest says `validation: ok`.

The executor must prepare, but not execute, a recovery command that:

1. finds the missing `assets.file_path` through SQLite;
2. confirms exactly one live metadata row references it;
3. confirms the backup file exists;
4. compares expected `size_bytes` to the backup file size;
5. copies only that one file into the live `assets/` directory;
6. re-runs an integrity query and reports counts.

Do not restore the whole database. Do not overwrite any existing asset. Do not run until the user approves through the architect.

---

## Phase 1: File Card Correctness and Resource Bounds

### Task 4: Bound preview reads and move filesystem I/O outside the DB mutex

**Files:**
- Modify: `src-tauri/src/domain/asset_service.rs`
- Modify: `src-tauri/src/commands/filesystem_aliases.rs`
- Modify: `src-tauri/src/commands/assets.rs`
- Create or modify: `src-tauri/tests/asset_service.rs`

**Step 1: Add a failing bounded-read test**

Create a file larger than the preview limit, call `read_text_preview`, and assert the returned preview is bounded. Structure the production function around `File::open().take(limit)` so the implementation cannot allocate the full file.

**Step 2: Implement bounded reading**

Use `std::fs::File`, `std::io::Read`, and `take((limit + 1) as u64)`. Do not call `fs::read`.

**Step 3: Separate file copying from metadata insertion**

Refactor import into three explicit stages:

1. validate source and derive safe destination while not holding the DB mutex;
2. copy bytes / generate Quick Look thumbnail while not holding the mutex;
3. acquire the mutex for a short transaction that inserts asset metadata and the File Card.

On transaction failure, remove only newly created managed files. Never remove the source file.

**Step 4: Add failure-cleanup tests**

Cover unknown board, conflicting card ID, failed metadata insert, and thumbnail generation failure. Assert no orphan asset row or managed file remains.

**Step 5: Verify**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test asset_service
cargo test --manifest-path src-tauri/Cargo.toml --test workspace_repository file_card
cargo test --manifest-path src-tauri/Cargo.toml
```

**Step 6: Commit**

```bash
git add src-tauri/src/domain/asset_service.rs src-tauri/src/commands/filesystem_aliases.rs src-tauri/src/commands/assets.rs src-tauri/tests/asset_service.rs
git commit -m "fix: bound file previews and shorten database locks"
```

---

### Task 5: Return generated thumbnails immediately

**Files:**
- Modify: `src-tauri/src/commands/filesystem_aliases.rs`
- Modify: `src-tauri/tests/workspace_repository.rs` or create a command-level test module
- Modify: `src/services/tauri-workspace-gateway.test.ts`

**Step 1: Add a failing test**

For a file whose thumbnail is generated, assert the returned `FileCardDto.preview_asset` is populated and equals the persisted projection.

**Step 2: Return the persisted DTO**

After the transaction, load the card through `workspace_repository::load_card` and return its `FileCardDto`. Do not manually reconstruct a second DTO with `preview_asset: None`.

**Step 3: Verify and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml file_card
npm test -- src/services/tauri-workspace-gateway.test.ts
git add src-tauri/src/commands/filesystem_aliases.rs src-tauri/tests/workspace_repository.rs src/services/tauri-workspace-gateway.test.ts
git commit -m "fix: return file card thumbnails without reload"
```

---

## Phase 2: Async Correctness

### Task 6: Make Search latest-request-wins

**Files:**
- Modify: `src/App.tsx`
- Create or modify: `src/search/SearchBar.test.tsx`
- Prefer create: `src/search/use-workspace-search.ts`
- Prefer create: `src/search/use-workspace-search.test.ts`

**Step 1: Add a failing deferred-promise test**

Issue query `pro`, then `project`. Resolve `project` first and `pro` last. Assert only `project` results remain and loading is not cleared by the stale request.

**Step 2: Extract a search controller hook**

Use a monotonically increasing request token. Capture the token before awaiting and update `results`, `error`, and `loading` only when it still matches the latest token. Empty query invalidates pending requests and clears results.

**Step 3: Verify and commit**

```bash
npm test -- src/search/use-workspace-search.test.ts src/search/SearchBar.test.tsx
npm run typecheck
git add src/App.tsx src/search/use-workspace-search.ts src/search/use-workspace-search.test.ts src/search/SearchBar.test.tsx
git commit -m "fix: ignore stale workspace search responses"
```

---

### Task 7: Scope viewport persistence to a board revision

**Files:**
- Modify: `src/App.tsx`
- Prefer create: `src/state/use-viewport-persistence.ts`
- Prefer create: `src/state/use-viewport-persistence.test.ts`

**Step 1: Add a failing board-switch test**

Schedule a zoom save for Board A, navigate to Board B before 400 ms, and assert:

- no A revision is written into B state;
- either A is flushed with A's captured revision before navigation or its pending save is explicitly cancelled;
- no stale-revision banner appears on B.

**Step 2: Choose one explicit policy**

Recommended policy: flush Board A before loading Board B. Store a pending record containing `{ boardId, revision, viewport }`; never read a global revision ref when the timer fires.

**Step 3: Include viewport persistence in navigation flush**

`navigateTo()` must await both the mutation queue and pending viewport persistence before applying another snapshot.

**Step 4: Verify and commit**

```bash
npm test -- src/state/use-viewport-persistence.test.ts src/state/current-board-store.test.ts
npm run typecheck
git add src/App.tsx src/state/use-viewport-persistence.ts src/state/use-viewport-persistence.test.ts
git commit -m "fix: isolate viewport saves by board"
```

---

### Task 8: Balance the native drop subscription lifecycle

**Files:**
- Modify: `src/services/drag-drop.ts`
- Modify: `src/services/drag-drop.test.ts`

**Step 1: Add a failing cleanup-before-listen test**

Delay the `listen()` promise, call cleanup, then resolve the promise. Assert the returned unlisten function is called exactly once and the drop callback is never delivered.

**Step 2: Implement cancellation-aware registration**

Track `disposed`. When registration resolves, call the new unlisten immediately if already disposed; otherwise retain it for normal cleanup. Handle dynamic import/listen rejection without unhandled promises.

**Step 3: Verify and commit**

```bash
npm test -- src/services/drag-drop.test.ts
npm run typecheck
git add src/services/drag-drop.ts src/services/drag-drop.test.ts
git commit -m "fix: balance native drop subscriptions"
```

---

### Task 9: Eliminate the cross-board drag runtime exception

**Files:**
- Modify: `src/canvas/CanvasAdapter.tsx`
- Modify: `src/canvas/CanvasAdapter.test.tsx`
- Modify: `tests/e2e/tab-drop.spec.ts`

**Step 1: Make the E2E test fail on page errors**

Attach a local `page.on("pageerror")` collector in `tab-drop.spec.ts` and assert it remains empty. Confirm the test now fails with the existing undefined-node exception.

**Step 2: Add a component regression test**

Simulate a drag whose board snapshot replacement removes the dragged node before drag-stop. The adapter must still clean listeners/highlights and must not call persistence with an undefined node.

**Step 3: Fix lifecycle ownership**

The drag session must retain the dragged card ID independently from the transient React Flow node. Treat a missing stop-node as cancellation/consumed cross-board drag, run cleanup, and return. A null guard alone is acceptable only if the test also proves cleanup and no duplicate commit.

**Step 4: Verify and commit**

```bash
npm test -- src/canvas/CanvasAdapter.test.tsx
npx playwright test tests/e2e/tab-drop.spec.ts
git add src/canvas/CanvasAdapter.tsx src/canvas/CanvasAdapter.test.tsx tests/e2e/tab-drop.spec.ts
git commit -m "fix: finish cross-board drag after canvas replacement"
```

---

### Checkpoint MIXED-GROUP-MOVE: define an atomic backend contract

**ASK ARCHITECT before changing the gateway or Rust command surface.**

Current behavior starts the leaf batch and Board Portal commands independently. The recommended design is one Rust transaction that validates every expected revision first, then moves all leaf cards and reparents all selected boards, or changes nothing.

The executor must provide:

- proposed `MoveSelectionToBoardInput` DTO;
- leaf placement policy (`unsorted` versus explicit frame);
- Board Portal reparenting rules and cycle validation;
- undo payload/receipt design;
- behavior when the selection contains the target board's own portal;
- test matrix for stale leaf, stale board, descendant cycle, and partial failure.

Do not silently choose a UI-only workaround. If a single atomic command is disproportionate, the alternative must explicitly prohibit mixed leaf+portal group drops in the UI and explain that limitation to the user.

---

### Task 10: Implement the approved mixed group-move contract

**Files:**
- Modify: `src-tauri/src/domain/models.rs`
- Modify: `src-tauri/src/repositories/workspace_repository.rs`
- Modify: `src-tauri/src/commands/cards.rs` or create a dedicated command module
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/services/workspace-gateway.ts`
- Modify: `src/services/tauri-workspace-gateway.ts`
- Modify: `src/services/mock-workspace-gateway.ts`
- Modify: `src/commands/*`
- Modify: `src/App.tsx`
- Modify: `src-tauri/tests/board_lifecycle.rs`
- Modify: `src-tauri/tests/workspace_repository.rs`
- Modify: `tests/e2e/group-tab-drop.spec.ts`

**Step 1: Write backend transaction tests first**

Assert all-or-nothing behavior for success, stale leaf revision, stale board revision, cycle, missing target, and replay/idempotency if the approved contract includes a receipt.

**Step 2: Implement the smallest approved Rust transaction**

Validate all entities before the first update. Keep cycle checks and revision increments inside the same transaction.

**Step 3: Wire gateway and command history**

Use one frontend command and one durable backend operation. Do not keep parallel fire-and-forget portal loops.

**Step 4: Strengthen E2E**

The test must select at least one leaf and one movable Board Portal, verify both disappear from the source, verify both appear/reparent in the target, reload, and verify persistence. Include a forced backend failure and assert neither item moved.

**Step 5: Verify and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
npm test
npx playwright test tests/e2e/group-tab-drop.spec.ts
git add src-tauri src/services src/commands src/App.tsx tests/e2e/group-tab-drop.spec.ts
git commit -m "fix: move mixed selections atomically across boards"
```

---

## Phase 3: Restore Trustworthy Quality Gates

### Task 11: Repair Vitest, ESLint, and Clippy

**Files:**
- Modify: `src/app/AppShell.test.tsx`
- Modify: `src/app/AppShell.tsx` only if behavior is actually wrong
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `eslint.config.js`
- Modify: Clippy-reported Rust files

**Step 1: Update the stale title-bar test**

Test the imperative `startDragging()` contract and interactive-element exclusions. Do not restore `data-tauri-drag-region` solely to satisfy an obsolete assertion.

**Step 2: Diagnose ESLint with the smallest supported version adjustment**

Pin a compatible ESLint/typescript-eslint combination. Do not use broad overrides or disable recommended rules. Because dependency versions change, document the exact package versions selected in the commit message/body.

**Step 3: Fix Clippy findings without blanket allows**

- remove the unit-valued `let` binding;
- box the large `CardDto` variants only if the serde/IPC contract remains unchanged; otherwise ask architect before changing DTO layout;
- replace unnecessary lazy `or_else` calls;
- remove test-only unnecessary `mut`.

**Step 4: Verify and commit**

```bash
npm run check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
git add package.json package-lock.json eslint.config.js src/app/AppShell.test.tsx src-tauri
git commit -m "chore: restore frontend and rust quality gates"
```

---

### Task 12: Make E2E fail on runtime errors and avoid stale servers

**Files:**
- Modify: `playwright.config.ts`
- Create: `tests/e2e/fixtures.ts`
- Modify: all `tests/e2e/*.spec.ts` imports as needed

**Step 1: Create a shared Playwright fixture**

Collect `pageerror` and unexpected `console.error` events. Fail the test during teardown with all collected messages. Allow only explicit, narrowly matched errors documented beside the allowlist.

**Step 2: Stop reusing arbitrary port 1420 servers**

Recommended local policy: `reuseExistingServer: false` and a test-only port supplied to both Vite and Playwright. If parallel worktrees need concurrent E2E, derive or allocate a free port in the script rather than hard-coding shared `1420`.

**Step 3: Prove the harness**

Temporarily trigger a page error in a local uncommitted edit and verify one E2E fails; revert that temporary line, rerun, and verify green. Do not commit the injected error.

**Step 4: Verify and commit**

```bash
npm run test:e2e
git add playwright.config.ts tests/e2e
git commit -m "test: fail e2e on browser runtime errors"
```

---

### Task 13: Add a continuous integration gate

**Files:**
- Create: `.github/workflows/ci.yml`

**Step 1: Add one non-deploying workflow**

Run on pull requests and pushes to `main`:

```text
npm ci
npm run check
npm run build
npm run test:e2e
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Use dependency caches but no secrets, signing, packaging, or deployment.

**Step 2: Validate the workflow syntax locally where possible**

At minimum, parse YAML and run every listed command locally.

**Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: enforce frontend rust and e2e gates"
```

---

## Phase 4: Remaining Functional Debt

### Task 14: Deduplicate existing favicons by favicon identity

**Files:**
- Modify: `src-tauri/src/domain/link_metadata.rs`
- Modify: `src-tauri/tests/link_metadata.rs`
- Modify migration only if a durable schema change is required; never edit an applied migration in place

**Step 1: Add a failing test using different YouTube video URLs**

Create two Embed Cards with different `source_url` values but the same favicon URL/host identity. Assert startup collapse reuses one favicon asset.

**Step 2: Define canonical cache identity**

Runtime already keys by favicon URL. Make startup collapse use the same identity. If historical rows do not store favicon URL, derive a host-level key only for known-safe identical favicons or add a new append-only migration that stores `favicon_source_url`.

**ASK ARCHITECT** if a schema migration is required. Do not infer favicon equivalence solely from arbitrary page hosts when pages can declare different icons.

**Step 3: Verify and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test link_metadata
cargo test --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/domain/link_metadata.rs src-tauri/tests/link_metadata.rs src-tauri/migrations src-tauri/src/db/migrations.rs
git commit -m "fix: deduplicate favicons by canonical source"
```

---

### Task 15: Make Unicode search excerpts boundary-safe

**Files:**
- Modify: `src-tauri/src/repositories/workspace_repository.rs`
- Modify: `src-tauri/tests/search.rs`

**Step 1: Add a failing Unicode expansion test**

Include case-folding characters where lowercasing changes byte length, for example text containing `İ` before another multibyte character. Search must not panic and must return a valid excerpt.

**Step 2: Stop applying byte offsets from a lowercased string to the original string**

Use a mapping from folded character positions back to original character boundaries, or use a Unicode-aware matching helper already present in the dependency set. Do not slice `text[..byte_start]` with an index derived from another string.

**Step 3: Verify and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test search
git add src-tauri/src/repositories/workspace_repository.rs src-tauri/tests/search.rs
git commit -m "fix: build unicode-safe search excerpts"
```

---

### Task 16: Add a close-flush contract for pending drafts

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/editor/use-document-draft.ts`
- Modify: corresponding tests
- May create: `src/app/use-close-flush.ts`

**ASK ARCHITECT before choosing Tauri close interception behavior.**

The proposal must answer:

- whether the window close is delayed until queue flush completes;
- timeout and user-visible failure behavior;
- whether viewport and note queues share one flush coordinator;
- how repeated close requests are handled;
- how browser mode differs from packaged Tauri.

After approval, write failure-first tests, implement the narrow hook, verify that the final draft survives close/reopen, and commit independently.

---

## Phase 5: Structural Debt After Correctness Is Green

### Task 17: Split orchestration out of `App.tsx`

**Files:**
- Modify: `src/App.tsx`
- Create focused hooks/controllers under `src/app/`, `src/search/`, and `src/navigation/`
- Move tests with their extracted behavior

Current size: approximately 2460 lines, 77 callbacks, 16 effects, 23 gateway methods.

**Step 1: Do not begin until Tasks 2-16 are green**

This is behavior-preserving only. No UI redesign, new features, or schema changes.

**Step 2: Extract by durable responsibility, one commit at a time**

Recommended order:

1. search controller;
2. viewport persistence controller;
3. native file-drop controller;
4. cross-board drag controller;
5. trash controller;
6. board navigation/tabs controller.

Each extraction must leave `App.tsx` as composition/orchestration, preserve the gateway boundary, and keep tests green before the next extraction.

**Step 3: Avoid a generic mega-hook**

Each controller owns one state machine and exposes a small typed interface. Do not merely move the same 500 lines into `useAppController`.

**Step 4: Commit each extraction separately**

Use `refactor:` commit messages and run focused tests plus `npm run check` after every extraction.

---

### Task 18: Split `workspace_repository.rs` by aggregate

**Files:**
- Modify: `src-tauri/src/repositories/workspace_repository.rs`
- Create modules under `src-tauri/src/repositories/`
- Modify: `src-tauri/src/repositories/mod.rs` if introduced

Current size: approximately 2377 lines.

Recommended modules:

- `boards.rs`
- `cards.rs`
- `assets.rs`
- `trash.rs`
- `search.rs`
- `quick_boards.rs`

Move code without changing SQL or public behavior. Keep transaction ownership in domain services rather than distributing cross-aggregate transactions across repositories. One module move per commit; run all Rust tests after each move.

---

### Checkpoint SECURITY-HARDENING: Tauri CSP and IPC surface

**ASK ARCHITECT before enabling a production CSP.**

The executor should prepare a short proposal covering:

- current `csp: null` in `src-tauri/tauri.conf.json`;
- required sources for Vite/Tauri, `myspace-asset:`, and the sandboxed HTML iframe;
- confirmation that `sandbox=""` remains on HTML File Card previews;
- whether filesystem-path commands need additional origin/capability restrictions;
- packaged-app smoke tests after CSP activation.

Do not ship a guessed CSP that breaks asset previews or Tauri IPC.

---

## Phase 6: Documentation and Final Verification

### Task 19: Replace optimistic status documentation with evidence

**Files:**
- Modify: `tasks/current-state.md`
- Modify: `tasks/todo.md`
- Modify or remove if obsolete: `.continue-here.md`
- Create: `docs/testing/v1-stabilization-report.md`

**Step 1: Update status only after all required gates pass**

Remove claims such as “крупного незакрытого кода нет” until supported by the final verification run. Record the asset-loss incident and recovery outcome without including private filenames or note contents.

**Step 2: Establish one source of truth**

The repository currently has no `docs/SOT.md`. Either designate `tasks/current-state.md` explicitly as the SOT or create `docs/SOT.md` that links to detailed backlog documents. Do not maintain two competing status narratives.

**Step 3: Record residual debt honestly**

Keep wishlist work separate from correctness debt. Record any deferred CSP, close-flush, bundle splitting, or repository decomposition with owner and reason.

**Step 4: Commit**

```bash
git add tasks/current-state.md tasks/todo.md .continue-here.md docs/testing/v1-stabilization-report.md
git commit -m "docs: record v1 stabilization evidence and residual debt"
```

---

### Task 20: Run the final release-quality verification

**Files:**
- No product changes during this task.

**Step 1: Confirm a clean branch**

```bash
git status --short --branch
git diff --check
```

Expected: no uncommitted changes.

**Step 2: Run all automated gates from fresh dependency/build state available in the worktree**

```bash
npm run check
npm run build
npm run test:e2e
npm audit --json
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: every command exits 0; E2E emits no unexpected page/console errors; dependency audit reports zero known vulnerabilities.

**Step 3: Run packaged macOS acceptance**

Use `docs/testing/folder-shortcut-manual.md` plus these additions:

- create/open/reveal text, large log, PDF, Office, HTML, and ZIP File Cards;
- restart and verify every managed file still renders/opens;
- verify one favicon is reused across different YouTube links;
- perform mixed cross-board movement and restart;
- close with a pending note edit and verify persistence if Task 16 was approved and implemented.

Do not substitute `tauri dev` for signed packaged bookmark durability.

**Step 4: Request final review**

Send the user:

```text
Нужен финальный архитектурный review.
Ветка/commit: <hash>.
Автоматические проверки: <exact counts and commands>.
Восстановление asset: <performed/not performed and approval reference>.
Остаточный долг: <explicit list>.
```

Do not merge until the architect reviews the final diff and the user confirms the live-data recovery result.

---

## Required Commit Order

1. `fix: preserve file card assets during garbage collection`
2. `fix: make asset cleanup failures observable`
3. `fix: bound file previews and shorten database locks`
4. `fix: return file card thumbnails without reload`
5. `fix: ignore stale workspace search responses`
6. `fix: isolate viewport saves by board`
7. `fix: balance native drop subscriptions`
8. `fix: finish cross-board drag after canvas replacement`
9. approved mixed group-move commit
10. `chore: restore frontend and rust quality gates`
11. `test: fail e2e on browser runtime errors`
12. `ci: enforce frontend rust and e2e gates`
13. favicon and Unicode search fixes
14. approved close-flush implementation, if selected
15. behavior-preserving structural refactors
16. documentation/evidence commit

Never squash the data-integrity fixes together with refactoring. Their diffs must remain independently reviewable and revertible.
