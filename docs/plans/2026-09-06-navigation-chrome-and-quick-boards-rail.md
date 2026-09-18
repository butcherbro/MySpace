# Navigation Chrome and Quick Boards Rail Implementation Plan

**Goal:** Recompose MySpace navigation so breadcrumbs live in the native macOS title-bar area, open Boards remain in a distinct browser-like tab strip with visual identities, and Quick Boards move into a collapsible vertical rail on the right.

**Architecture:** Keep the three navigation concepts separate: breadcrumbs are hierarchy, tabs are session working-set, and Quick Boards are persisted bookmarks. First finish the in-flight Board cover slice, then expose one shared Board visual-identity read model and renderer. Build the tab and right-rail UI on that stable identity before switching the Tauri window to an overlay title bar, because the title-bar change affects the whole application shell and needs real-macOS verification.

**Tech Stack:** Tauri 2, React 19, TypeScript, Rust, SQLite, Vitest, Testing Library, Playwright, CSS design tokens.

---

## Locked product decisions

- Breadcrumbs remain text-only and always show the root-to-current Board path.
- The Board tab strip remains directly below the title bar; this plan does not remove tabs or change their session behavior.
- Each tab shows a Board identity thumbnail, title, and close affordance where applicable.
- Tabs must read as separate controls, not one continuous sentence.
- Quick Boards move out of the title bar into a docked right rail.
- The right rail has expanded and collapsed states; collapse state is session-only in this slice.
- Expanded Quick Boards use small one-line labels and scroll vertically.
- When a compact fallback cannot show the title, derive an acronym from the
  first letter of each of the first three words (`Books` -> `B`, `YouTube
  Services` -> `YS`). The full title remains available through the visible
  label/tooltip.
- The left creation rail remains fixed and unchanged.
- Do not render a Search control until Search is functional.
- Undo and Redo are real controls, backed by the existing command dispatcher; no dead buttons.
- Board hierarchy, tab closing, Quick Board persistence, and canvas coordinates must not change as part of the visual recomposition.

## Immediate implementation decision (2026-09-06)

The first shippable slice is the **always-expanded vertical Quick Boards rail**.
It intentionally precedes the tab and title-bar redesign because moving the
already-functional bookmarks immediately frees the top navigation row. Implement
Tasks 2, 3, and 5 first. Task 6 (collapse) remains planned but must not be bundled
into this first slice.

## Target layout

```text
┌───────────────────────────────────────────────────────────────────────┐
│ macOS lights   Home / Parent / Current                Search*  ↶  ↷ │
├───────────────────────────────────────────────────────────────────────┤
│             [■ Home]  [▧ Books ×]  [■ Research ×]                   │
├──────┬───────────────────────────────────────────────────┬────────────┤
│ left │                                                   │ Quick      │
│ tool │                   Canvas                          │ Boards   ‹ │
│ rail │                                                   │            │
└──────┴───────────────────────────────────────────────────┴────────────┘
```

`Search*` is shown only after its separate functional slice exists.

### Visual measurements to validate in the mockup

- Title-bar content height: 44–48 CSS px, calibrated in the real Tauri window.
- Tab strip: 34–36 px.
- Tab gap: 3–4 px.
- Tab identity thumbnail: 18–20 px.
- Tab label: 12–13 px, one line, ellipsis.
- Expanded Quick Boards rail: 156–168 px.
- Collapsed rail: 28–32 px.
- Quick Board row: 28–32 px.
- Quick Board label: 11–12 px, one line, ellipsis.

---

### Task 0: Approve static shell states before implementation

**Files:**
- Create: `docs/design/navigation-shell-expanded.png`
- Create: `docs/design/navigation-shell-collapsed.png`
- Create: `docs/design/navigation-shell-dense-board.png`
- Modify after approval: `.interface-design/system.md`

**Step 1: Draw the expanded state**

Show native traffic lights, text-only breadcrumbs, Undo/Redo, separated Board tabs with identity thumbnails, the unchanged left rail, and the expanded right Quick Boards rail.

**Step 2: Draw the collapsed state**

Use the same Board and viewport. Collapse only the right rail to its arrow strip so the canvas expansion is visible.

**Step 3: Draw the dense-board state**

Use at least twelve Board Portals plus Notes, Images, and Link Cards. Verify that both rails and the tab strip remain visually subordinate to the canvas.

**Step 4: Resolve the Home-tab question visually**

Compare the current pinned Home tab against a variant without it. Do not change `board-tabs.ts` unless the user explicitly chooses the second variant; this is a navigation behavior decision, not styling.

**Step 5: Record the accepted state**

Update `.interface-design/system.md` so it no longer says Quick Boards follow breadcrumbs in the top bar and explicitly describes the right rail and title-bar breadcrumbs.

**Exit criterion:** the user approves all three states and the Home-tab treatment.

---

### Task 1: Finish and land the in-flight Board cover slice

**Files:**
- Existing in-flight files under `src-tauri/`, `src/cards/board/`, `src/services/`, and `src/App.tsx`
- Test: `src/cards/board/BoardPortalCard.test.tsx`
- Test: Rust Board lifecycle/asset tests selected by the cover implementation

**Step 1: Do not start shell edits in the dirty worktree**

The current Board cover work already modifies `src/App.tsx`, Rust DTOs, repository queries, gateways, and Board Portal components. Finish it without mixing navigation-shell changes into the same commit.

**Step 2: Run focused cover tests**

Run:

```bash
npm test -- src/cards/board/BoardPortalCard.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml board
```

Expected: PASS.

**Step 3: Run the full baseline**

Run:

```bash
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all existing tests pass.

**Step 4: Commit only the cover slice**

```bash
git add src-tauri src/App.tsx src/cards/board src/services
git commit -m "feat: add editable board covers"
```

**Exit criterion:** the worktree is clean and a Board can render its cover with a color/symbol fallback.

---

### Task 2: Add one authoritative Board visual-identity read model

**Files:**
- Modify: `src-tauri/src/domain/models.rs`
- Modify: `src-tauri/src/repositories/workspace_repository.rs`
- Modify: `src/services/workspace-gateway.ts`
- Modify: `src/services/mock-workspace-gateway.ts`
- Test: `src-tauri/tests/quick_boards.rs`
- Test: the existing Board snapshot repository tests

**Step 1: Write failing Rust tests**

Add coverage that:

- the current `BoardSummary` includes `colorToken`, `symbol`, and nullable `coverAsset`;
- `list_quick_boards` returns the same identity fields;
- a Board without a cover returns `coverAsset: null`.

**Step 2: Run the focused Rust tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml quick_boards
```

Expected: FAIL because the DTOs do not yet expose all identity fields.

**Step 3: Extend the DTO contracts**

Use the same field set for the current Board, tabs, and Quick Boards:

```ts
export interface BoardVisualIdentity {
  colorToken: string;
  symbol: string | null;
  coverAsset: AssetDto | null;
}

export interface BoardSummary extends BoardVisualIdentity {
  id: string;
  title: string;
  parentBoardId: string | null;
  revision: number;
}

export interface QuickBoardDto extends BoardVisualIdentity {
  boardId: string;
  title: string;
  sortOrder: number;
}
```

Mirror these fields in Rust with `#[serde(rename_all = "camelCase")]`.

**Step 4: Load identity data without per-item queries**

Join `boards.cover_asset_id` to `assets` in the Board snapshot and Quick Board list queries. Do not perform one asset query per tab/bookmark.

**Step 5: Update the mock gateway fixtures**

Every mock `BoardSummary` and `QuickBoardDto` must contain the identity fields and exercise both cover and fallback cases.

**Step 6: Run verification**

```bash
npm run typecheck
cargo test --manifest-path src-tauri/Cargo.toml quick_boards
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src-tauri/src/domain/models.rs src-tauri/src/repositories/workspace_repository.rs src-tauri/tests/quick_boards.rs src/services
git commit -m "feat: expose board visual identity to navigation"
```

---

### Task 3: Extract a shared Board identity thumbnail

**Files:**
- Create: `src/boards/BoardIdentityThumbnail.tsx`
- Create: `src/boards/board-identity-thumbnail.css`
- Create: `src/boards/BoardIdentityThumbnail.test.tsx`
- Modify: `src/cards/board/BoardPortalCard.tsx`

**Step 1: Write failing component tests**

Cover these cases:

- cover asset renders as an image;
- no cover renders the Board color and symbol;
- no symbol falls back to the first grapheme of the title;
- the image has useful alternative text in portal usage and is decorative in tab/bookmark usage.

**Step 2: Run the test**

```bash
npm test -- src/boards/BoardIdentityThumbnail.test.tsx
```

Expected: FAIL because the component does not exist.

**Step 3: Implement the component**

Use one replaceable boundary:

```ts
interface BoardIdentityThumbnailProps {
  title: string;
  colorToken: string;
  symbol: string | null;
  coverAsset: AssetDto | null;
  size: "portal" | "navigation";
  decorative?: boolean;
}
```

Keep URL construction and fallback behavior inside this component; tabs and Quick Boards must not duplicate it.

**Step 4: Migrate BoardPortalCard**

Replace the portal's inline cover/symbol branch with `BoardIdentityThumbnail`. Preserve the current portal silhouette and event handling.

**Step 5: Verify and commit**

```bash
npm test -- src/boards/BoardIdentityThumbnail.test.tsx src/cards/board/BoardPortalCard.test.tsx
npm run typecheck
git add src/boards src/cards/board/BoardPortalCard.tsx
git commit -m "refactor: share board identity thumbnail"
```

---

### Task 4: Give Board tabs visual identity and clear separation

**Files:**
- Modify: `src/navigation/board-tabs.ts`
- Modify: `src/navigation/BoardTabs.tsx`
- Modify: `src/navigation/board-tabs.css`
- Modify: `src/App.tsx`
- Test: `src/navigation/board-tabs.test.ts`
- Test: `src/navigation/BoardTabs.test.tsx`

**Step 1: Write failing model tests**

Verify that opening and syncing a tab keeps its complete visual identity and that a cover change updates an already-open tab without changing order or active Board.

**Step 2: Extend BoardTab**

```ts
export interface BoardTab extends BoardVisualIdentity {
  boardId: string;
  title: string;
}
```

Pass a `BoardTab` object to open/sync functions rather than adding more positional arguments.

**Step 3: Write failing component tests**

Verify that tabs render the shared thumbnail, title, close behavior, active state, and ellipsis container. Preserve ARIA tab semantics.

**Step 4: Render the thumbnail**

Place `BoardIdentityThumbnail` before the label. The thumbnail is decorative because the adjacent title already names the Board.

**Step 5: Separate the tabs visually**

Implement:

- `gap: 4px` between tabs;
- independent 1 px quiet edges;
- 6 px top radius;
- active white surface and slightly stronger edge/shadow;
- inactive quiet gray surface;
- 12–13 px title, one-line ellipsis;
- maximum tab width so one long title cannot consume the strip.

Do not use large pill radii or saturated active colors.

**Step 6: Verify and commit**

```bash
npm test -- src/navigation/board-tabs.test.ts src/navigation/BoardTabs.test.tsx
npm run check
git add src/navigation src/App.tsx
git commit -m "style: distinguish open board tabs"
```

**Visual checkpoint:** this is the first user-visible slice. Stop and let the user test it before changing the shell.

---

### Task 5: Create the expanded vertical Quick Boards rail

**Files:**
- Create: `src/navigation/QuickBoardsRail.tsx`
- Create: `src/navigation/quick-boards-rail.css`
- Create: `src/navigation/QuickBoardsRail.test.tsx`
- Modify: `src/app/AppShell.tsx`
- Modify: `src/app/app-shell.css`
- Modify: `src/app/AppShell.test.tsx`
- Modify: `src/App.tsx`

**Step 1: Write failing AppShell tests**

Require an optional `rightRail` region and verify that the canvas remains a distinct main region.

**Step 2: Add the shell slot**

```ts
interface AppShellProps {
  topBar: ReactNode;
  toolRail: ReactNode;
  rightRail?: ReactNode;
  rightRailCollapsed?: boolean;
  children: ReactNode;
}
```

The right rail is docked, not an overlay, so it never hides cards.

**Step 3: Write failing QuickBoardsRail tests**

Port the existing open, remove, reorder, empty-drop-target, and ordering tests from `QuickBoardsBar.test.tsx`. Add cover and fallback thumbnail assertions.

**Step 4: Implement the expanded rail**

Render one vertical scrollable list with 28–32 px rows, 18–20 px thumbnails, 11–12 px labels, and a hover remove affordance. Remove the horizontal `MAX_VISIBLE = 8` overflow behavior; vertical scrolling replaces it.

**Step 5: Reuse the existing DnD contract**

Preserve `data-quick-boards-drop="true"`. Existing `elementFromPoint(...).closest(...)` hit testing in `App.tsx` should continue to pin a dragged Board Portal without moving it.

**Step 6: Wire the rail and remove the top-bar Quick Boards slot**

Move the Quick Boards component from `topBar` to `rightRail`. Do not change gateway calls or persistence.

**Step 7: Verify and commit**

```bash
npm test -- src/app/AppShell.test.tsx src/navigation/QuickBoardsRail.test.tsx
npm run check
npm run test:e2e
git add src/app src/navigation src/App.tsx
git commit -m "feat: move quick boards to right rail"
```

**Visual checkpoint:** test the expanded rail on a dense Board before adding collapse behavior.

---

### Task 6: Add right-rail collapse behavior

**Files:**
- Modify: `src/navigation/QuickBoardsRail.tsx`
- Modify: `src/navigation/quick-boards-rail.css`
- Modify: `src/app/AppShell.tsx`
- Modify: `src/app/app-shell.css`
- Modify: `src/App.tsx`
- Test: `src/navigation/QuickBoardsRail.test.tsx`
- Test: `src/app/AppShell.test.tsx`

**Step 1: Write failing behavior tests**

Verify:

- the arrow exposes `aria-expanded`;
- clicking it collapses and expands the rail;
- collapsed mode hides titles but leaves a visible reveal control;
- the collapsed edge remains a Quick Boards drop target;
- the state resets on application restart because persistence is out of scope.

**Step 2: Store session state in App**

```ts
const [quickBoardsCollapsed, setQuickBoardsCollapsed] = useState(false);
```

Do not add a SQLite setting or local-storage key in this slice.

**Step 3: Implement docked width states**

Use a shell modifier/data attribute to switch the right column between the approved expanded and collapsed widths. Respect `prefers-reduced-motion`; animate only width/opacity for at most 120 ms.

**Step 4: Keep drag-to-pin discoverable**

During a Board Portal drag, highlight the collapsed edge. Dropping on it must pin the Board even while the rail remains collapsed.

**Step 5: Verify and commit**

```bash
npm test -- src/navigation/QuickBoardsRail.test.tsx src/app/AppShell.test.tsx
npm run check
git add src/navigation/QuickBoardsRail.tsx src/navigation/quick-boards-rail.css src/app src/App.tsx
git commit -m "feat: collapse quick boards rail"
```

---

### Task 7: Put breadcrumbs in the macOS title-bar area

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src/app/AppShell.tsx`
- Modify: `src/app/app-shell.css`
- Modify: `src/navigation/board-breadcrumbs.css`
- Modify: `src/App.css`
- Test: `src/app/AppShell.test.tsx`
- Test: `src/navigation/BoardBreadcrumbs.test.tsx`

**Step 1: Write failing shell tests**

Verify that the title-bar region contains a dedicated non-interactive drag spacer and that breadcrumbs remain buttons. Do not place `data-tauri-drag-region` on the breadcrumb buttons.

**Step 2: Configure the Tauri window**

Keep native decorations and use the macOS overlay title bar:

```json
{
  "title": "MySpace",
  "titleBarStyle": "Overlay",
  "hiddenTitle": true,
  "decorations": true
}
```

Do not make the whole window transparent and do not enable macOS private APIs for this feature.

**Step 3: Recompose the title-bar content**

Render, left to right:

1. protected traffic-light inset;
2. text-only breadcrumbs;
3. a flexible drag spacer marked directly with `data-tauri-drag-region`;
4. functional right-side actions.

Remove the old Quick Boards drop zone from this row. Do not render the application name in web content.

**Step 4: Preserve title-bar drag behavior**

Only empty background/spacer areas initiate window dragging. Breadcrumbs, Undo, and Redo remain clickable. A double-click on the spacer should retain native maximize/zoom behavior where Tauri provides it.

**Step 5: Verify browser-mode tests**

```bash
npm test -- src/app/AppShell.test.tsx src/navigation/BoardBreadcrumbs.test.tsx
npm run check
```

Expected: PASS.

**Step 6: Verify the real macOS window**

```bash
npm run tauri dev
```

Manually verify:

- native close/minimize/zoom buttons remain functional;
- `MySpace` is not visible in the title bar;
- all breadcrumbs are clickable;
- dragging the empty title-bar area moves the window;
- breadcrumb clicks do not drag the window;
- normal, maximized, and restored windows keep correct alignment;
- Retina rendering has no 1 px overlap between title bar and tab strip.

**Step 7: Commit**

```bash
git add src-tauri/tauri.conf.json src/app src/navigation/board-breadcrumbs.css src/App.css
git commit -m "feat: move breadcrumbs into macos title bar"
```

---

### Task 8: Add reactive Undo and Redo title-bar controls

**Files:**
- Modify: `src/commands/command-dispatcher.ts`
- Modify: `src/commands/command-dispatcher.test.ts`
- Create: `src/navigation/UndoRedoControls.tsx`
- Create: `src/navigation/UndoRedoControls.test.tsx`
- Modify: `src/App.tsx`

**Step 1: Write failing dispatcher subscription tests**

The dispatcher currently exposes `canUndo()` and `canRedo()` but React is not notified when the stacks change. Add a small subscription contract and verify it emits after execute, undo, and redo, but not after a failed command.

**Step 2: Implement dispatcher subscriptions**

```ts
subscribe(listener: () => void): () => void
```

Notify after a successful history mutation. Do not expose or duplicate the internal stacks.

**Step 3: Write failing control tests**

Verify disabled states, accessible names, tooltips/keyboard hints, and calls to the existing `undo()`/`redo()` paths.

**Step 4: Render the controls**

Use the existing local outline icon boundary. Editor-owned text undo remains unchanged; these controls operate on workspace history when invoked.

**Step 5: Verify and commit**

```bash
npm test -- src/commands/command-dispatcher.test.ts src/navigation/UndoRedoControls.test.tsx
npm run check
git add src/commands src/navigation/UndoRedoControls.tsx src/navigation/UndoRedoControls.test.tsx src/App.tsx
git commit -m "feat: add title bar undo redo controls"
```

---

### Task 9: Remove obsolete horizontal Quick Boards code

**Files:**
- Delete: `src/navigation/QuickBoardsBar.tsx`
- Delete: `src/navigation/quick-boards-bar.css`
- Delete: `src/navigation/QuickBoardsBar.test.tsx`
- Modify: any remaining imports found by `rg`

**Step 1: Prove the old component is unused**

```bash
rg -n "QuickBoardsBar|quick-boards-bar" src tests
```

Expected: only the obsolete component and its old test remain.

**Step 2: Delete the obsolete files**

Use the repository patch mechanism; do not leave two competing Quick Boards presentations.

**Step 3: Verify and commit**

```bash
npm run check
npm run test:e2e
git add -A src/navigation
git commit -m "refactor: remove horizontal quick boards bar"
```

---

### Task 10: End-to-end and visual acceptance gate

**Files:**
- Modify: `tests/e2e/canvas-smoke.spec.ts`
- Modify: `.interface-design/system.md`
- Modify: `tasks/todo.md`

**Step 1: Add an end-to-end navigation test**

Cover this user flow:

1. open two nested Boards so multiple tabs exist;
2. switch between tabs without deleting Boards;
3. use a breadcrumb to navigate to an ancestor;
4. pin a Board Portal by dropping it on the right rail;
5. open it from Quick Boards;
6. collapse and expand the rail;
7. verify the canvas remains interactive.

**Step 2: Run automated verification**

```bash
npm run check
npm run test:e2e
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all suites pass.

**Step 3: Run real-app visual verification**

At Retina scale, test:

- Home and a three-level nested Board;
- tabs with cover, symbol, fallback letter, long title, and Cyrillic title;
- 1, 8, and 30 Quick Boards;
- expanded and collapsed right rail;
- a dense Board with at least twelve Portals and mixed cards;
- narrow supported window width;
- window move, maximize, restore, and application restart.

**Step 4: Record the outcome**

Update `.interface-design/system.md` with final measured dimensions and update `tasks/todo.md` so tabs and Quick Boards are no longer marked as future/not started.

**Step 5: Commit**

```bash
git add tests/e2e/canvas-smoke.spec.ts .interface-design/system.md tasks/todo.md
git commit -m "test: verify navigation shell composition"
```

---

## Execution order and checkpoints

1. **Completed prerequisite:** Task 1 (Board covers, commit `78eb30e`).
2. **Immediate data and visual foundation:** Tasks 2–3.
3. **First visible result:** Task 5 (always-expanded right Quick Boards rail).
4. **User checkpoint:** verify cover/fallback identity, small labels, reorder,
   open/remove, and drag-to-pin in the real app.
5. **Second visible result:** Task 4 (tab identity and separation).
6. **Design checkpoint for later shell work:** Task 0.
7. **Later, not in the first rail slice:** Task 6 (collapse).
8. **Highest-risk shell change:** Task 7 (native title-bar overlay).
9. **Finish the title bar:** Task 8 (Undo/Redo).
10. **Cleanup and proof:** Tasks 9–10.

Do not run Tasks 2–8 in parallel because they converge on `src/App.tsx`, navigation DTOs, and shell layout. Documentation/mockup work in Task 0 may proceed while the Board cover slice is being completed.

## Deliberately deferred

- Search implementation (`Command-K`) and its result palette.
- Persisting the collapsed right-rail preference.
- Dragging cards between open Board tabs.
- Tab reordering and tab persistence across restarts.
- Removing the pinned Home tab, unless explicitly approved at Task 0.
- Filesystem aliases and agent chat surfaces.
