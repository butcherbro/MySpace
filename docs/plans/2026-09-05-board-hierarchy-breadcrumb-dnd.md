# Board Hierarchy and Breadcrumb Drag-and-Drop Implementation Plan

**Goal:** Restore a root-first, fully navigable `Home / … / Current Board` path and let users reorganize Notes and Boards with Finder-like drag-and-drop onto Board Portals or any ancestor breadcrumb.

**Architecture:** SQLite remains authoritative for the Board tree. Moving a Board is one revision-guarded transaction that updates both `boards.parent_board_id` and the Board's unique portal-card location while rejecting Home moves, self-parenting, cross-workspace moves, and descendant cycles. React Flow continues to own canvas gestures behind `CanvasAdapter`; it emits application-owned card IDs and screen points, while `App` resolves breadcrumb drop targets without leaking React Flow types into navigation or persistence.

**Tech Stack:** Tauri 2, Rust, rusqlite recursive CTEs, React, TypeScript, React Flow, Vitest, Playwright.

---

## Required behavior

1. Breadcrumb order is always root-to-leaf: `Home / Parent / Current Board`.
2. Home is always the first visible crumb and navigates to the workspace root Board.
3. Every visible Board name is a button. The current Board carries `aria-current="page"`; activating it is a safe same-board navigation rather than a disabled control.
4. On deep paths, ordinary display may collapse middle ancestors. During a drag, the full path expands so every ancestor becomes a real drop target.
5. Dropping a Note, Image, or Link Card on an ancestor breadcrumb moves that card to the selected Board through the existing leaf-card command.
6. Dropping a Board Portal on another Board Portal moves the underlying Board under the target Board. It does not copy the Board or create a second portal.
7. Dropping a Board Portal on a breadcrumb moves the underlying Board to that ancestor. This is the primary way to lift a deeply nested Board back to Home or another ancestor.
8. A successful Board move preserves the entire moved subtree and atomically moves its unique portal. The moved portal starts at `{ x: 40, y: 40 }` in the destination Board.
9. Home cannot be moved. A Board cannot become its own parent or a descendant of itself. Rejected drops leave both hierarchy and portal placement unchanged.
10. One drag gesture is one undoable command.

## Current defects and reusable foundations

- `src-tauri/src/repositories/workspace_repository.rs` documents root-first breadcrumbs but assigns the current Board depth `0`, ancestors negative depths, and uses `ORDER BY depth DESC`. This returns current-to-root and explains the screenshots. The query must order ascending.
- `src/navigation/BoardBreadcrumbs.tsx` already renders buttons and collapses middle ancestors, but disables the last element. After the SQL fix, this would disable the current Board correctly; the new contract instead keeps it actionable and marks it with `aria-current`.
- `src-tauri/src/repositories/workspace_repository.rs::move_card_to_board` intentionally accepts only `note`, `image`, and `embed`. Do not widen this query to `board_portal`: a Board move must also update `boards.parent_board_id`, so it needs a separate transaction.
- `src/canvas/CanvasAdapter.tsx::portalAtPoint` currently excludes a dragged `board_portal`. This is why Board-on-Board drop cannot work.
- `boards.parent_board_id`, the unique `board_portal_cards.target_board_id`, and the existing card revision fields are sufficient. No migration is required.

### Task 1: Fix breadcrumb order at the repository boundary

**Files:**
- Modify: `src-tauri/src/repositories/workspace_repository.rs`
- Test: `src-tauri/tests/workspace_repository.rs`

**Step 1: Write the failing repository test**

Create `Home -> A -> B`, load B, and assert breadcrumb IDs are `[home, a, b]`. Also assert a Home snapshot returns `[home]`.

**Step 2: Run the focused test and verify RED**

Run: `cd src-tauri && cargo test --offline --test workspace_repository breadcrumb -- --nocapture`

Expected: the nested assertion receives `[b, a, home]`.

**Step 3: Correct the recursive query ordering**

Keep current depth `0` and ancestor depths negative, but change the final sort to `ORDER BY depth ASC`. Do not reverse the vector in the frontend; the repository owns the path contract for every client.

**Step 4: Run the focused and full Rust tests**

Run:

```bash
cd src-tauri
cargo test --offline --test workspace_repository breadcrumb -- --nocapture
cargo test --offline
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src-tauri/src/repositories/workspace_repository.rs src-tauri/tests/workspace_repository.rs
git commit -m "fix: return breadcrumbs from Home to current board"
```

### Task 2: Make the breadcrumb navigation contract explicit

**Files:**
- Modify: `src/navigation/BoardBreadcrumbs.tsx`
- Modify: `src/navigation/board-breadcrumbs.css`
- Test: `src/navigation/BoardBreadcrumbs.test.tsx`

**Step 1: Write failing component tests**

Cover Home-first order, every name being a button, Home/middle/current navigation, `aria-current="page"`, and deep-path collapse only outside drag mode.

**Step 2: Run the test and verify RED**

Run: `npm test -- --run src/navigation/BoardBreadcrumbs.test.tsx`

Expected: the current crumb is disabled and lacks `aria-current`.

**Step 3: Implement the minimal navigation change**

Render each crumb as an enabled button. Apply `aria-current="page"` to the crumb whose ID equals `currentBoardId`; do not infer current state from the post-collapse array index. The existing `onNavigate(boardId)` remains the only click boundary.

**Step 4: Verify GREEN**

Run: `npm test -- --run src/navigation/BoardBreadcrumbs.test.tsx`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/navigation/BoardBreadcrumbs.tsx src/navigation/board-breadcrumbs.css src/navigation/BoardBreadcrumbs.test.tsx
git commit -m "fix: make the board path root-first and navigable"
```

### Task 3: Add an atomic Board reparenting command

**Files:**
- Modify: `src-tauri/src/domain/models.rs`
- Modify: `src-tauri/src/domain/board_service.rs`
- Modify: `src-tauri/src/commands/boards.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/tests/board_lifecycle.rs`

**Step 1: Define the IPC input**

Add `MoveBoardInput` with Board ID, expected Board revision, expected portal revision, target parent Board ID, and target frame. The backend discovers the unique portal through `board_portal_cards.target_board_id`; do not trust a frontend-supplied portal ID.

**Step 2: Write failing service tests**

Cover sibling-to-child movement, lifting a nested Board to Home, subtree preservation, Home/self/descendant/cross-workspace rejection, stale Board and portal revisions, missing/trashed targets, rollback, and duplicate-portal prevention.

**Step 3: Run the tests and verify RED**

Run: `cd src-tauri && cargo test --offline --test board_lifecycle move_board -- --nocapture`

Expected: missing command/service symbols.

**Step 4: Implement one transaction**

Inside one rusqlite transaction:

1. Load the active source Board and reject `parent_board_id IS NULL`.
2. Load the active target parent and require the same `workspace_id`.
3. Use a recursive CTE rooted at `board_id`; reject if `target_parent_board_id` belongs to that subtree.
4. Load the active unique portal card and validate its revision.
5. Update `boards.parent_board_id`, Board revision, and timestamp with the expected Board revision guard.
6. Update the portal card's `board_id`, destination frame, revision, and timestamp with the expected portal revision guard.
7. Commit only after both guarded updates succeed.

Do not create/delete a portal row and do not touch descendant Boards.

**Step 5: Register and verify the Tauri command**

Register `move_board` in `src-tauri/src/lib.rs`, then run:

```bash
cd src-tauri
cargo fmt --all -- --check
cargo test --offline --test board_lifecycle move_board -- --nocapture
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src-tauri/src/domain/models.rs src-tauri/src/domain/board_service.rs src-tauri/src/commands/boards.rs src-tauri/src/lib.rs src-tauri/tests/board_lifecycle.rs
git commit -m "feat: reparent boards and their portals atomically"
```

### Task 4: Add gateway and undo contracts

**Files:**
- Modify: `src/services/workspace-gateway.ts`
- Modify: `src/services/tauri-workspace-gateway.ts`
- Modify: `src/services/mock-workspace-gateway.ts`
- Modify: `src/services/tauri-workspace-gateway.test.ts`
- Modify: `src/services/mock-workspace-gateway.test.ts`
- Create: `src/commands/board-commands.ts`
- Create: `src/commands/board-commands.test.ts`

**Step 1: Write failing gateway tests**

Assert camelCase input maps to `invoke("move_board", { input })` and the mock changes both Board parent and portal location without duplicating either.

**Step 2: Add `moveBoard(input)` to `WorkspaceGateway`**

Mirror the Rust DTO exactly. Do not reuse `moveCardToBoard`, because that command is deliberately leaf-only.

**Step 3: Implement `MoveBoardCommand`**

Capture source parent, source portal frame, Board revision, and portal revision before execute. Undo calls the same domain boundary with the previous parent/frame and the post-execute revisions. One execute/undo is one dispatcher history entry.

**Step 4: Run focused tests**

Run: `npm test -- --run src/services/tauri-workspace-gateway.test.ts src/services/mock-workspace-gateway.test.ts src/commands/board-commands.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/services src/commands/board-commands.ts src/commands/board-commands.test.ts
git commit -m "feat: expose undoable board reparenting"
```

### Task 5: Support Board-on-Board drops inside the canvas

**Files:**
- Modify: `src/canvas/canvas-types.ts`
- Modify: `src/canvas/CanvasAdapter.tsx`
- Modify: `src/canvas/CanvasAdapter.test.tsx`
- Modify: `src/App.tsx`

**Step 1: Write failing adapter tests**

Cover the existing leaf-card drop, Board Portal A onto Board Portal B, self-target exclusion, and normal canvas positioning when no target exists.

**Step 2: Add an application-owned event**

Extend `CanvasEvents` with a Board-specific drop event using only string IDs. Do not expose React Flow `Node` or event types.

**Step 3: Generalize target hit-testing**

Allow a `board_portal` source to find other portal targets, but exclude the source card ID. Route leaf and Board sources to different App handlers.

**Step 4: Execute the undoable command in App**

Resolve the source portal DTO from `cardsRef`, execute `MoveBoardCommand`, then reload the current Board. The portal disappears from the old parent only after persistence succeeds.

**Step 5: Verify**

Run: `npm test -- --run src/canvas/CanvasAdapter.test.tsx src/commands/board-commands.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/canvas src/App.tsx
git commit -m "feat: move boards by dropping portals onto portals"
```

### Task 6: Turn breadcrumbs into cross-surface drop targets

**Files:**
- Modify: `src/canvas/canvas-types.ts`
- Modify: `src/canvas/CanvasAdapter.tsx`
- Modify: `src/navigation/BoardBreadcrumbs.tsx`
- Modify: `src/navigation/board-breadcrumbs.css`
- Modify: `src/navigation/BoardBreadcrumbs.test.tsx`
- Modify: `src/App.tsx`

**Step 1: Write failing interaction tests**

Cover full-path expansion during drag, hover styling and cleanup, leaf-card and Board-portal drops, same-location no-op, and Escape/cancel cleanup.

**Step 2: Add a screen-point drag bridge**

React Flow uses pointer gestures, not native HTML5 drag-and-drop. Add application-owned drag-move and drag-end events containing `{ cardId, clientX, clientY }`. In `App`, resolve `document.elementFromPoint(clientX, clientY)?.closest('[data-board-drop-id]')` and keep only the hovered Board ID in React state.

Do not put DOM breadcrumb knowledge inside `CanvasAdapter` and do not rely on `pointerenter` while React Flow holds pointer capture.

**Step 3: Expose breadcrumb targets**

Render `data-board-drop-id={crumb.id}` on each crumb button. Add `dragActive`, `dropTargetBoardId`, and `currentBoardId` props. When `dragActive`, bypass `collapseMiddle` and render the full root-to-current path so hidden ancestors are reachable.

**Step 4: Route the drop in App**

- `note`/`image`/`embed` -> existing `moveCardToBoard` command.
- `board_portal` -> new undoable `moveBoard` command using the portal's `target.id`.

Clear hover state after success, rejection, cancellation, and unmount. Display a non-destructive error for cycle/stale-revision rejection.

**Step 5: Verify focused tests**

Run: `npm test -- --run src/navigation/BoardBreadcrumbs.test.tsx src/canvas/CanvasAdapter.test.tsx`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/navigation src/canvas src/App.tsx
git commit -m "feat: move cards and boards through breadcrumb drops"
```

### Task 7: Add end-to-end hierarchy acceptance

**Files:**
- Modify: `tests/e2e/canvas-smoke.spec.ts`
- Modify if needed: `src/services/mock-workspace-gateway.ts`

**Step 1: Add root-first navigation coverage**

Create/open `Home -> A -> B`, assert visible order `Home / A / B`, click Home, and assert the Home Board opens.

**Step 2: Add Board-on-Board coverage**

On Home create A and B, drag A's portal onto B, open B, and assert A is now present there. Open A and assert `Home / B / A`.

**Step 3: Add breadcrumb lifting coverage**

From a deep Board, drag a nested Board Portal to Home in the breadcrumb path. Navigate Home and assert the moved Board appears exactly once with its subtree intact.

**Step 4: Add leaf-card breadcrumb coverage**

Move a Note from a nested Board to Home through the Home crumb, then verify its content on Home.

**Step 5: Verify all gates**

Run:

```bash
npm run check
npm run build
npm run test:e2e
cd src-tauri && cargo fmt --all -- --check && cargo test --offline
```

Expected: all commands exit `0` with no failed tests.

**Step 6: Perform live Tauri acceptance**

Run `npm run tauri dev` against the normal app data and verify breadcrumb order/clicks, Board-on-Board movement, lifting a deep Board to Home, persistence after restart, and Undo. Do not use an isolated empty diagnostic database as user-facing evidence.

**Step 7: Commit**

```bash
git add tests/e2e/canvas-smoke.spec.ts src/services/mock-workspace-gateway.ts
git commit -m "test: cover Finder-like board organization"
```

## Done criteria

- The path is never reversed and never omits Home.
- Clicking any breadcrumb opens the represented Board.
- All ancestors are available as drop targets during a drag, including Home.
- Leaf Cards and Board Portals follow distinct persistence commands.
- Moving a Board updates its parent and unique portal atomically.
- Home/self/descendant/cross-workspace moves are rejected without partial writes.
- Undo and restart preserve a valid, cycle-free hierarchy.
