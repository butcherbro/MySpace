# Trash View and Empty Trash Implementation Plan

**Goal:** Add a Milanote-style Trash entry at the bottom of the fixed left rail, let the user inspect and restore deleted work, and only then add an explicitly confirmed permanent empty operation with safe asset garbage collection.

**Architecture:** Existing `deleted_at` and `trash_batch_id` fields remain the source of truth. The first reversible slice exposes Trash batches as a read model and restores only complete batches, preserving mixed selections and Board subtrees. Permanent deletion is a separate slice guarded by a fresh validated backup; database rows are hard-deleted transactionally, then unreferenced managed asset files are removed by an idempotent mark-and-sweep pass that also runs at startup.

**Tech Stack:** Tauri 2, Rust, rusqlite/SQLite, React 19, TypeScript, Vitest, Testing Library, Playwright.

---

## Product and safety decisions

- The Trash button is always anchored at the bottom-left of the 56 px tool rail. It is navigation, not a creation tool.
- A non-zero badge shows the number of recoverable Trash batches, not every descendant card inside a deleted Board subtree.
- Clicking Trash opens an application drawer over the workspace. Trash is not represented as a Board and must not create a Board tab.
- The drawer groups deletion results by `trashBatchId`. A batch is the minimum restore unit in V1 because one delete may contain a mixed selection or an entire Board subtree.
- Each group shows its deletion time, representative top-level items, and affected Board/card counts. Descendant cards are summarized rather than rendered as separate restore rows.
- The first slice supports inspection and `Restore`. It does not permanently delete anything.
- `Empty Trash…` ships only in the second slice. It requires a fresh validated backup and a confirmation dialog that states the number of batches, Boards, cards, and managed assets affected.
- The user must type `EMPTY` before the permanent action is enabled. Cancel and any backup failure leave all data unchanged.
- Asset GC follows permanent row deletion. It removes only assets referenced by no remaining `image_cards` or `embed_cards` row. Replaced Link previews and future Board covers therefore share the same collector.
- Never infer that old active objects are Trash content. Only rows with non-null `deleted_at` are eligible.

## Trash read model

Add the following shared IPC shape in Rust and mirror it in TypeScript:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashBatchDto {
    pub batch_id: String,
    pub deleted_at: i64,
    pub items: Vec<TrashEntryDto>,
    pub board_count: i64,
    pub card_count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntryDto {
    pub id: String,
    pub kind: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashSummaryDto {
    pub batches: Vec<TrashBatchDto>,
    pub batch_count: i64,
    pub board_count: i64,
    pub card_count: i64,
}
```

Representative entries are derived without adding a new persistence table:

- a deleted Board is top-level when its parent is not in the same Trash batch;
- a deleted leaf card is top-level when its owning Board is not deleted in the same batch;
- the primary portal of a deleted Board is not listed as a second item;
- Note titles use a bounded `plain_text` excerpt, Image titles prefer caption then filename, Link titles use title then source URL, and Boards use their title.

Sort batches by `deleted_at DESC, batch_id DESC`. Bound excerpts to 120 Unicode scalar values and return at most 100 batches in V1.

### Task 1: Add backend Trash listing contracts

**Files:**
- Modify: `src-tauri/src/domain/models.rs`
- Modify: `src-tauri/src/domain/trash_service.rs`
- Modify: `src-tauri/src/commands/trash.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/tests/trash_lifecycle.rs`

**Steps:**

1. Add failing Rust tests for an empty Trash, one deleted Note, a mixed Note plus Board batch, and a deleted Board subtree whose descendants are summarized rather than duplicated.
2. Run `cargo test --manifest-path src-tauri/Cargo.toml --test trash_lifecycle` and confirm the listing tests fail because `list_trash` does not exist.
3. Add `TrashEntryDto`, `TrashBatchDto`, and `TrashSummaryDto` to `models.rs`.
4. Implement `trash_service::list_trash(&Connection) -> Result<TrashSummaryDto, WorkspaceError>` with bounded deterministic queries and no mutation.
5. Expose `#[tauri::command] list_trash` and register it in the Tauri invoke handler.
6. Re-run the focused Rust suite and confirm it passes.
7. Commit with `feat: expose recoverable trash summary`.

### Task 2: Add the frontend gateway boundary

**Files:**
- Modify: `src/services/workspace-gateway.ts`
- Modify: `src/services/tauri-workspace-gateway.ts`
- Modify: `src/services/mock-workspace-gateway.ts`
- Test: `src/services/tauri-workspace-gateway.test.ts`
- Test: `src/services/mock-workspace-gateway.test.ts`

**Steps:**

1. Add failing tests for `listTrash()` IPC mapping and for mock batch listing/restoration.
2. Run `npm test -- src/services/tauri-workspace-gateway.test.ts src/services/mock-workspace-gateway.test.ts` and confirm failure.
3. Mirror the three Trash DTOs in TypeScript and add `listTrash(): Promise<TrashSummaryDto>` to `WorkspaceGateway`.
4. Implement the Tauri adapter with `invoke("list_trash")`.
5. Extend the mock to retain enough deleted metadata to produce the same batch contract.
6. Re-run the focused tests and confirm they pass.
7. Commit with `feat: add trash gateway contract`.

### Task 3: Anchor Trash at the bottom of the tool rail

**Files:**
- Modify: `src/components/icons/Icon.tsx`
- Modify: `src/components/tool-rail/ToolRail.tsx`
- Modify: `src/components/tool-rail/tool-rail.css`
- Modify: `src/App.tsx`
- Test: `src/components/tool-rail/ToolRail.test.tsx`

**Steps:**

1. Add failing component tests that the creation tools keep their order, Trash is a distinct bottom action, and its badge is hidden at zero and shows the batch count above zero.
2. Run `npm test -- src/components/tool-rail/ToolRail.test.tsx` and confirm failure.
3. Add the outline `trash` icon to the existing icon system.
4. Split the rail into a creation group and a bottom group using `margin-top: auto`; keep the fixed 56 px width and existing keyboard focus treatment.
5. Pass `trashBatchCount` and `onOpenTrash` from `App.tsx`. Refresh the count on startup, after Trash/restore, and after cross-process refresh.
6. Re-run the component tests and confirm they pass.
7. Commit with `feat: add trash entry to tool rail`.

### Task 4: Implement the recoverable Trash drawer

**Files:**
- Create: `src/components/trash/TrashDrawer.tsx`
- Create: `src/components/trash/trash-drawer.css`
- Create: `src/components/trash/TrashDrawer.test.tsx`
- Modify: `src/App.tsx`

**Steps:**

1. Add failing tests for loading, empty, populated, error, close, and restore states.
2. Run `npm test -- src/components/trash/TrashDrawer.test.tsx` and confirm failure.
3. Render a right-side drawer over the canvas with heading `Trash`, an explicit close button, and batches newest first.
4. Show representative rows plus `N Boards · M cards`; do not render deleted cards through `card-registry`.
5. Wire `Restore` to the existing `restoreTrashBatch(batchId)` command. Disable only the active row while restoring.
6. After success, reload the current Board projection, refresh Quick Boards/tabs if needed, and refresh Trash.
7. On failure, keep the drawer and batch visible and show the backend error; never optimistically remove a batch before commit.
8. Re-run tests and commit with `feat: add recoverable trash drawer`.

### Task 5: Prove Trash survives navigation and restart boundaries

**Files:**
- Create: `tests/e2e/trash-drawer.spec.ts`

**Steps:**

1. Add an e2e scenario that creates a Note and child Board, deletes both in one selection, navigates away and back, opens Trash, and sees one recoverable batch.
2. Restore the batch and verify the Note and Board Portal return at their original Board and placement.
3. Add empty-state and keyboard/focus assertions for the rail button and drawer close action.
4. Run `npm run test:e2e`.
5. Run `npm run check && cargo test --manifest-path src-tauri/Cargo.toml`.
6. Commit with `test: cover trash inspection and restore`.

## Permanent emptying and asset GC

Start this section only after Tasks 1–5 are released and manually exercised against a copied workspace.

### Task 6: Add a mandatory pre-empty backup gate

**Files:**
- Modify: `src-tauri/src/db/backup.rs`
- Modify: `src-tauri/src/domain/models.rs`
- Modify: `src-tauri/src/domain/trash_service.rs`
- Test: `src-tauri/tests/backup.rs`
- Test: `src-tauri/tests/trash_lifecycle.rs`

**Steps:**

1. Add failing tests that Empty Trash is not attempted when a fresh database/assets backup cannot be created and validated.
2. Extract a synchronous `snapshot_before_destructive_operation` path that bypasses startup rate limiting and returns the validated backup location.
3. Add `EmptyTrashResult` counts for batches, Boards, cards, and orphan assets.
4. Require backup success before opening the deletion transaction.
5. Re-run focused tests and commit with `feat: guard empty trash with validated backup`.

### Task 7: Hard-delete only trashed relational rows

**Files:**
- Modify: `src-tauri/src/domain/trash_service.rs`
- Test: `src-tauri/tests/trash_lifecycle.rs`

**Steps:**

1. Add failing tests with active and trashed Notes, Images, Links, nested Boards, view states, portals, and Quick Board references.
2. In one SQLite transaction, delete detail rows for trashed cards, primary portal rows targeting trashed Boards, trashed cards, view states for trashed Boards, and trashed Boards from leaves to roots.
3. Reject the operation if the root Board is marked deleted; never repair that invariant inside a destructive command.
4. Commit the transaction and return counts. Do not delete files while the SQLite transaction is open.
5. Re-run focused tests and commit with `feat: permanently delete trashed workspace rows`.

### Task 8: Add idempotent mark-and-sweep asset GC

**Files:**
- Modify: `src-tauri/src/domain/asset_service.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/tests/asset_gc.rs`

**Steps:**

1. Add failing tests for a referenced asset, unreferenced asset, shared asset, already-missing orphan file, and interrupted sweep.
2. Mark assets referenced by remaining `image_cards.asset_id`, `embed_cards.asset_id`, or `embed_cards.favicon_asset_id` rows. Extend the union when Board covers are implemented.
3. For each unmarked asset, validate its stored filename, delete the file first, treat `NotFound` as success, and only then delete its metadata row.
4. Run the bounded sweep on startup so interrupted cleanup converges.
5. Re-run all Rust tests and commit with `feat: collect orphaned managed assets`.

### Task 9: Add the confirmed Empty Trash UI

**Files:**
- Modify: `src/services/workspace-gateway.ts`
- Modify: `src/services/tauri-workspace-gateway.ts`
- Modify: `src/services/mock-workspace-gateway.ts`
- Modify: `src/components/trash/TrashDrawer.tsx`
- Create: `src/components/trash/EmptyTrashDialog.tsx`
- Create: `src/components/trash/EmptyTrashDialog.test.tsx`
- Modify: `src-tauri/src/commands/trash.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `tests/e2e/trash-drawer.spec.ts`

**Steps:**

1. Add failing adapter, dialog, and e2e tests before registering `empty_trash`.
2. Add `emptyTrash(confirmation: string): Promise<EmptyTrashResult>` across the gateway; Rust independently requires exact token `EMPTY`.
3. Put `Empty Trash…` in the drawer footer, visually separated from restore actions and disabled when empty.
4. Show affected counts, backup notice, irreversible warning, and typed confirmation.
5. Keep the dialog open on errors and identify the failed phase. If only GC remains, state that startup cleanup will retry.
6. On success, refresh summary/badge and show the backup location.
7. Run `npm run check && npm run test:e2e && npm run build && cargo test --manifest-path src-tauri/Cargo.toml`.
8. Manually verify with a disposable copied workspace before live data.
9. Commit with `feat: add confirmed empty trash flow`.

## Completion criteria

- The bottom-left badge and drawer reflect SQLite after navigation, restart, undo/restore, and cross-process refresh.
- Restoring a Board batch restores its complete hierarchy and original portal placement atomically.
- Opening or closing Trash never mutates workspace data.
- Empty Trash cannot run without a fresh validated backup and explicit typed confirmation.
- Permanent deletion never touches active rows or the root Board.
- Asset GC never deletes a referenced asset and converges after interruption.
- All frontend, e2e, production-build, and Rust checks pass.
