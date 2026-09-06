# Quiet Desk Visual Shell Implementation Plan

**Goal:** Replace the prototype web-toolbar shell with a quiet, Mac-first spatial frame whose fixed rail, navigation bar, canvas, and object materials remain readable on dense Boards.

**Architecture:** Keep all workspace behavior in `App.tsx`, gateways, commands, and `CanvasAdapter`; this slice changes composition and presentation, not persistence. Extract small visual components for the shell, navigation, rail, icons, and context menu, then theme React Flow through one canvas stylesheet. `.interface-design/system.md` is authoritative for appearance and this plan is authoritative for the first visual implementation order.

**Tech Stack:** Tauri 2, React 19, TypeScript, CSS custom properties, React Flow, Tiptap, Vitest, Testing Library, Playwright.

---

## Product intent

The primary user works with crowded Boards containing long Notes, screenshots,
Links, and nested Boards. The canvas is the product. Chrome must recede, and each
object type must remain recognizable by silhouette and material when text is too
small to read.

```text
┌────────────────────────────────────────────────────────────────────┐
│ Home / … / Current Board     Quick Boards       Search   Undo Redo │
├──────┬─────────────────────────────────────────────────────────────┤
│ Note │                                                             │
│ Link │                    quiet dotted Desk                        │
│Board │                                                             │
│Image │       Paper       Image       Link       Portal             │
│      │                                                             │
└──────┴─────────────────────────────────────────────────────────────┘
```

## Locked decisions

1. Use the macOS system font stack. Do not add a web-font dependency.
2. The web-content top bar is `44px`; the fixed rail is `56px`.
3. The separate `MySpace` header, board-title row, note count, and creation toolbar disappear.
4. Breadcrumbs are the navigation anchor. Do not repeat the current Board title.
5. The top bar contains Breadcrumbs and Quick Boards on the left; Search, Undo,
   and Redo occupy the right command group. Never render a visible command before
   its behavior and disabled state are wired.
6. The default rail contains Note, Link, Board, and Image only.
7. The Link tool creates a new editable Note at the normal placement; pasting one URL uses the existing Note-to-Link conversion. Do not build a second Link creation flow in this visual slice.
8. Existing `Copy MySpace Link`, Image-only `Copy File Path`, and Delete behavior survive the context-menu refactor.
9. A Board Portal context action targets the nested Board, not the portal Card.
10. Preserve every existing click, drag, edit, DnD, clipboard, undo, and keyboard contract.
11. Undo and Redo are right-aligned icon buttons. They use the same workspace
    command history as `Command-Z` / `Command-Shift-Z`; they are never a second
    independent history implementation.

## Relationship to the earlier interface plan

This plan supersedes Tasks 1–5, 9, and the visual-acceptance portion of Task 12
in `docs/plans/2026-09-04-spatial-workspace-interface.md`. The earlier plan remains
the source for contextual rail behavior, Note appearance, shared rich-text tools,
creation placement, and Search until those receive their own refreshed slices.

## NOT in scope

- Contextual rail modes and persisted Note colors: a later interaction slice after the fixed rail is stable.
- Browser-like Board tabs: the next navigation feature, with its own state contract.
- Quick Boards persistence or drop targets: depends on stable top navigation and tabs.
- Global Search UI and indexing: required later, but must not appear as an inactive icon.
- Board covers, icon editing, Columns, Lines, To-do Cards, and Audio: do not copy Milanote's unused tool inventory.
- Dark-mode polish beyond token completeness: first acceptance is the light dense-board reference.
- Any database migration or Rust domain change.

## Completion gate

At `1512×982` CSS pixels:

- top bar and rail form one quiet L-shaped frame;
- the canvas begins directly below/right of that frame and never scrolls the chrome;
- no creation controls remain above the canvas;
- Home is the first clickable breadcrumb;
- Undo and Redo are visible at the top-right, expose their keyboard hints, and
  accurately reflect empty workspace history;
- Notes look like paper, Images like unframed media, Links like previews, and Portals like doorways;
- default React Flow blue selection chrome is absent;
- a mixed dense fixture remains scannable at zoom 1 and 0.75;
- all existing unit and e2e tests pass.

### Task 1: Establish the global visual tokens

**Files:**

- Create: `src/styles/tokens.css`
- Create: `src/styles/global.css`
- Modify: `src/main.tsx`
- Modify: `src/app/AppShell.tsx`
- Test: `src/app/AppShell.test.tsx`

**Step 1: Write the failing theme-boundary test**

Assert that the shell exposes the accepted direction without testing computed CSS:

```tsx
render(<AppShell>Desk</AppShell>);
expect(screen.getByTestId("app-shell")).toHaveAttribute("data-theme", "system");
```

**Step 2: Run the focused test and confirm failure**

Run: `npm test -- src/app/AppShell.test.tsx`

Expected: FAIL because `AppShell` has no `data-theme` contract yet.

**Step 3: Add tokens from the accepted design system**

Move the exact light tokens from `.interface-design/system.md` into `tokens.css`.
Include typography, `4px` spacing increments, radii, edges, focus halo, and the
three shadow levels. Add a token-driven dark block, but do not tune individual
Cards inside it.

**Step 4: Add the global root treatment**

`global.css` owns reset, full-window sizing, system font stack, text hierarchy,
`-webkit-font-smoothing: antialiased`, `-moz-osx-font-smoothing: grayscale`,
focus-visible defaults, and `prefers-reduced-motion`.

Remove the global `button` styling and raw palette from `App.css`; controls must
be styled by their own component.

**Step 5: Import styles exactly once**

```ts
import "./styles/tokens.css";
import "./styles/global.css";
import "./App.css";
```

**Step 6: Verify**

Run: `npm test -- src/app/AppShell.test.tsx && npm run typecheck`

Expected: PASS.

**Step 7: Commit**

```bash
git add src/styles src/main.tsx src/app/AppShell.tsx src/app/AppShell.test.tsx src/App.css
git commit -m "style: establish quiet desk tokens"
```

### Task 2: Turn AppShell into top-bar, rail, and canvas regions

**Files:**

- Modify: `src/app/AppShell.tsx`
- Modify: `src/app/app-shell.css`
- Modify: `src/app/AppShell.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.css`

**Step 1: Write the failing slot test**

```tsx
render(
  <AppShell topBar={<span>Trail</span>} toolRail={<span>Tools</span>}>
    <span>Desk</span>
  </AppShell>,
);
expect(screen.getByTestId("top-bar-region")).toHaveTextContent("Trail");
expect(screen.getByTestId("tool-rail-region")).toHaveTextContent("Tools");
expect(screen.getByTestId("canvas-region")).toHaveTextContent("Desk");
```

Also assert that the old visible `MySpace` product header is absent.

**Step 2: Run the focused test and confirm failure**

Run: `npm test -- src/app/AppShell.test.tsx`

Expected: FAIL because the current shell accepts children only.

**Step 3: Implement the explicit shell contract**

```ts
interface AppShellProps {
  topBar: ReactNode;
  toolRail: ReactNode;
  children: ReactNode;
}
```

Render CSS Grid with rows `44px minmax(0, 1fr)` and columns
`56px minmax(0, 1fr)`. The top bar spans both columns. The rail and canvas own
their cells; the outer window uses `overflow: hidden`.

**Step 4: Remove prototype chrome from App**

Delete `.workspace__toolbar`, `.workspace__board-title`, and `.workspace__count`.
Do not move business handlers yet. Render the existing creation buttons as
temporary rail-slot content with their accessible names unchanged, so this
structural commit does not break Playwright before Task 4 replaces them.

**Step 5: Verify geometry and behavior**

Run: `npm test -- src/app/AppShell.test.tsx && npm run typecheck && npm run test:e2e`

Expected: PASS. No intermediate commit may leave the existing e2e suite red.

**Step 6: Commit**

```bash
git add src/app src/App.tsx src/App.css
git commit -m "refactor: define spatial shell regions"
```

### Task 3: Add the local outline icon boundary

**Files:**

- Create: `src/components/icons/Icon.tsx`
- Create: `src/components/icons/icon.css`
- Create: `src/components/icons/Icon.test.tsx`

**Step 1: Write failing accessibility tests**

Cover labelled and decorative icons:

```tsx
render(<Icon name="note" label="New note" />);
expect(screen.getByLabelText("New note")).toBeInTheDocument();

const { container } = render(<Icon name="board" />);
expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
```

**Step 2: Run and confirm failure**

Run: `npm test -- src/components/icons/Icon.test.tsx`

Expected: FAIL because the component does not exist.

**Step 3: Implement only the required semantic set**

```ts
export type IconName =
  | "note"
  | "link"
  | "board"
  | "image"
  | "arrow-left"
  | "search"
  | "undo"
  | "redo"
  | "bookmark";
```

Use project-owned SVG paths in one map. Every icon has `viewBox="0 0 24 24"`,
`fill="none"`, `stroke="currentColor"`, `strokeWidth="1.7"`, rounded caps and
joins. Do not install an icon dependency in this slice.

**Step 4: Verify**

Run: `npm test -- src/components/icons/Icon.test.tsx && npm run lint`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/icons
git commit -m "feat: add workspace icon boundary"
```

### Task 4: Build the fixed creation rail

**Files:**

- Create: `src/components/tool-rail/ToolButton.tsx`
- Create: `src/components/tool-rail/ToolRail.tsx`
- Create: `src/components/tool-rail/tool-rail.css`
- Create: `src/components/tool-rail/ToolRail.test.tsx`
- Modify: `src/App.tsx`
- Modify: `tests/e2e/canvas-smoke.spec.ts`

**Step 1: Write failing rail tests**

Assert four commands, their order, accessible names, and handlers:

```tsx
expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label")))
  .toEqual(["New note", "New link", "New board", "Add image"]);
```

Tooltips must include the keyboard hint where one already works. Do not advertise
shortcuts that are not implemented.

**Step 2: Run and confirm failure**

Run: `npm test -- src/components/tool-rail/ToolRail.test.tsx`

Expected: FAIL because the rail does not exist.

**Step 3: Implement the visual contract**

The rail is `56px` wide, uses `--chrome-surface`, and has one
`--edge-subtle` right hairline. Each tool has a `40–48px` hit target, `20px`
outline icon, 10px label, and default/hover/active/focus/disabled states.

Do not use boxed white icon tiles for every idle tool. The active or hovered
tool may receive a quiet inset surface.

**Step 4: Wire existing App handlers**

- Note → `handleCreateNote()`.
- Link → `handleCreateNote()` and immediate edit; the user pastes a URL and the
  existing conversion predicate decides whether it becomes a Link Card.
- Board → `handleCreateChildBoard()`.
- Image → `handleCreateImage()`.

Remove the old top-toolbar buttons only after all four rail actions work.

**Step 5: Update e2e selectors without weakening behavior**

Continue selecting controls by accessible name. Existing creation, editing, Link
conversion, and Board hierarchy flows must pass without test-only branches.

Run: `npm test -- src/components/tool-rail && npm run test:e2e`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/components/tool-rail src/App.tsx tests/e2e/canvas-smoke.spec.ts
git commit -m "feat: move creation tools to the left rail"
```

### Task 5: Build the navigation-only top bar

**Files:**

- Create: `src/navigation/TopNavigationBar.tsx`
- Create: `src/navigation/top-navigation-bar.css`
- Create: `src/navigation/TopNavigationBar.test.tsx`
- Create: `src/navigation/QuickBoardsSlot.tsx`
- Create: `src/navigation/WorkspaceHistoryControls.tsx`
- Create: `src/navigation/workspace-history-controls.css`
- Create: `src/navigation/WorkspaceHistoryControls.test.tsx`
- Modify: `src/navigation/BoardBreadcrumbs.tsx`
- Modify: `src/navigation/board-breadcrumbs.css`
- Modify: `src/commands/command-dispatcher.ts`
- Modify: `src/commands/command-dispatcher.test.ts`
- Modify: `src/App.tsx`

**Step 1: Write failing composition tests**

Verify that the full Home-to-current trail lives in the top bar, Home stays
clickable, and an empty Quick Boards slot renders nothing and consumes no width.
The right group must contain accessible Undo and Redo icon buttons with `Command-Z`
and `Command-Shift-Z` hints. Both start disabled.

**Step 2: Run and confirm failure**

Run: `npm test -- src/navigation`

Expected: FAIL because the top-bar component does not exist.

**Step 3: Implement the top-bar layout**

Use a `44px` flex row. Breadcrumbs take only their content width, Quick Boards
consume the flexible middle, and Search/Undo/Redo form a right-aligned command
group. Do not render the current Board title in the center.

Preserve `data-board-drop-id`, `dropTargetBoardId`, click navigation, and the full
root-first path from the current `BoardBreadcrumbs` implementation.

**Step 4: Wire one observable workspace history**

Add a minimal subscription/snapshot boundary to `CommandDispatcher`; notify only
after successful execute/undo/redo stack changes. `App.tsx` observes this boundary
and passes `canUndo`, `canRedo`, `undoLabel`, and `redoLabel` to
`WorkspaceHistoryControls`. Button activation and keyboard shortcuts reuse the same
`handleUndo` / `handleRedo` callbacks, including error reporting and authoritative
Board reload. Do not duplicate history in React state.

While a rich-text editor owns focus, its native Tiptap `Command-Z` remains text
undo. Until an explicit editor-history bridge exists, keep the top workspace-history
buttons disabled during active editing rather than unexpectedly undoing a canvas
command.

**Step 5: Tune navigation and control styling**

Use 13px text, medium current crumb, secondary ancestors, tertiary separators,
32px minimum hit targets, no pill around every crumb, and one quiet focus ring.
History buttons are icon-only, `32px` square, transparent at rest, and use existing
outline icons. Disabled buttons remain visible but quiet and non-interactive.

**Step 6: Verify**

Run: `npm test -- src/navigation && npm run test:e2e`

Expected: PASS, including breadcrumb navigation and breadcrumb DnD.

**Step 7: Commit**

```bash
git add src/navigation src/commands/command-dispatcher.ts src/commands/command-dispatcher.test.ts src/App.tsx
git commit -m "feat: add top-bar workspace history controls"
```

### Task 6: Theme the Desk and neutralize React Flow defaults

**Files:**

- Create: `src/canvas/canvas.css`
- Modify: `src/canvas/CanvasAdapter.tsx`
- Modify: `src/canvas/CanvasAdapter.test.tsx`
- Modify: `src/App.css`

**Step 1: Write failing semantic-boundary tests**

Assert that the canvas root receives `data-canvas-surface="desk"` and that the
React Flow background remains dots with gap 20 and size 1. Do not test pixel color
through JSDOM.

**Step 2: Run and confirm failure**

Run: `npm test -- src/canvas/CanvasAdapter.test.tsx`

Expected: FAIL for the missing surface marker.

**Step 3: Add one scoped React Flow theme layer**

`canvas.css` owns the dotted Desk, pane cursors, node wrapper reset, selection
rectangle, selected-node outline reset, and attribution/control suppression if
those optional elements are rendered. Scope every override under
`.canvas-focusable` and use documented React Flow classes only.

Selected Cards must rely on application-owned state styling. Remove the default
bright blue node outline and resize treatment without disabling keyboard focus.

**Step 4: Verify**

Run: `npm test -- src/canvas && npm run test:e2e`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/canvas src/App.css
git commit -m "style: establish the quiet desk canvas"
```

### Task 7: Make Board Portals the signature object

**Files:**

- Modify: `src/cards/board/BoardPortalCard.tsx`
- Modify: `src/cards/board/board-portal-card.css`
- Modify: `src/cards/board/BoardPortalCard.test.tsx`

**Step 1: Write failing semantic-state tests**

Assert an explicit `data-kind="board-portal"` hook and preserve the existing
highlight/drop-target class contract. Keep opening, inline rename, keyboard, and
context-menu tests unchanged. Selection remains on the React Flow node wrapper
and is themed centrally in `canvas.css`; do not thread duplicate selection state
through every Card component.

**Step 2: Run and confirm failure**

Run: `npm test -- src/cards/board/BoardPortalCard.test.tsx`

Expected: FAIL for missing semantic appearance hooks.

**Step 3: Apply the Portal grammar**

- outer footprint: `112–124px`, transparent;
- tile: `60×60px`, radius `11px`, muted semantic color;
- symbol: restrained short mark, never emoji;
- title: 12px medium, one-line ellipsis;
- counts: 10–11px tertiary;
- hover: 1–2px visual lift through shadow only;
- selected: style the containing `.react-flow__node.selected` footprint through
  `canvas.css`, without adding a white Card or React Flow blue;
- drop target: stronger edge plus quiet halo, not a full opaque fill.

**Step 4: Verify**

Run: `npm test -- src/cards/board/BoardPortalCard.test.tsx && npm run typecheck`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/cards/board
git commit -m "style: make board portals the workspace signature"
```

### Task 8: Separate the material grammar of Notes, Images, and Links

**Files:**

- Modify: `src/cards/note/note-card.css`
- Modify: `src/cards/image/image-card.css`
- Modify: `src/cards/link/link-card.css`
- Modify: `src/editor/note-editor.css`
- Modify: `src/cards/note/NoteCard.test.tsx`
- Modify: `src/cards/image/ImageCard.tsx`
- Modify: `src/cards/image/ImageCard.test.tsx`
- Modify: `src/cards/link/EmbedCard.test.tsx`

**Step 1: Add semantic appearance assertions**

Test only meaningful component-owned hooks: editing, saving, error, has-caption,
metadata-loading, and metadata-failed. Selection is owned and styled by the React
Flow wrapper from Task 6. Do not snapshot entire class strings.

**Step 2: Run and confirm the new assertions fail**

Run: `npm test -- src/cards`

Expected: FAIL for any missing semantic hooks.

**Step 3: Style Notes as Paper**

Use `--paper`, 5px radius, `--shadow-paper`, and `12px 14px` padding. Remove the
permanent grey border. Editing/selection uses `--edge-focus` plus
`--focus-halo`. Reveal the resize handle only on hover, focus, or selection.

**Step 4: Style Images as media**

Remove the permanent outer white frame when there is no caption. Preserve the
image silhouette and aspect-ratio behavior. When a caption exists, add one compact
Paper strip below it with a soft separator.

**Step 5: Style Links as previews**

Keep the preview edge-to-edge. Use the accepted terracotta Link token instead of
generic browser blue, 11px tertiary source metadata, 15px medium title, and compact
Paper content padding. Loading and failed states retain card geometry so metadata
arrival does not create a jarring jump.

**Step 6: Verify**

Run: `npm test -- src/cards src/editor && npm run test:e2e`

Expected: PASS, including Note edit focus and Link conversion/enrichment flows.

**Step 7: Commit**

```bash
git add src/cards src/editor/note-editor.css
git commit -m "style: differentiate workspace object materials"
```

### Task 9: Extract and polish the type-aware context menu

**Files:**

- Create: `src/components/context-menu/ContextMenu.tsx`
- Create: `src/components/context-menu/context-menu.css`
- Create: `src/components/context-menu/ContextMenu.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.css`
- Modify: `tests/e2e/canvas-smoke.spec.ts`

**Step 1: Write failing menu-contract tests**

Use a data-driven action model:

```ts
interface ContextMenuAction {
  id: string;
  label: string;
  shortcut?: string;
  tone?: "default" | "danger";
  group: "primary" | "destructive";
  onSelect(): void;
}
```

Assert that empty groups produce no separator, keyboard focus starts at the first
action, Escape closes, and a danger action is not the only red surface.

**Step 2: Run and confirm failure**

Run: `npm test -- src/components/context-menu/ContextMenu.test.tsx`

Expected: FAIL because the component does not exist.

**Step 3: Implement the accepted menu surface**

Use 220–260px width, 8px radius, 4px padding, `--paper-raised`,
`--shadow-menu`, 32–34px rows, left labels, right shortcuts, and subtle group
hairlines. Clamp the menu inside the application window.

**Step 4: Preserve type-aware actions**

- Note/Link: Copy MySpace Link, Delete.
- Image: Copy MySpace Link, Copy File Path, Delete.
- Board Portal: Copy MySpace Link for `target.id`, Delete Board.

Do not add Duplicate, Lock, z-order, template, or Quick Board actions until their
commands exist.

**Step 5: Verify**

Run: `npm test -- src/components/context-menu && npm run test:e2e`

Expected: PASS, especially the existing clipboard and selection-delete scenarios.

**Step 6: Commit**

```bash
git add src/components/context-menu src/App.tsx src/App.css tests/e2e/canvas-smoke.spec.ts
git commit -m "style: add the workspace context menu"
```

### Task 10: Add dense-board visual acceptance

**Files:**

- Create: `src/test/dense-board-fixture.ts`
- Modify: `src/services/mock-workspace-gateway.ts`
- Create: `tests/e2e/visual-shell.spec.ts`
- Create: `docs/testing/visual-shell-manual.md`

**Step 1: Build a test-only dense fixture**

Create deterministic Notes, Images, Links, and at least twelve Board Portals with
stable IDs, frames, revisions, and content. Activate it only through an explicit
browser-test query parameter or injected mock fixture. Never seed production data.

**Step 2: Add structural Playwright assertions**

At `1512×982`, assert:

- top bar height and rail width are stable;
- the rail stays fixed while the canvas pans;
- creation tools are absent from the top bar;
- Home is clickable;
- all four object types render;
- context menus remain within the viewport.

Do not rely on broad screenshot pixel matching for interaction behavior.

**Step 3: Capture reference screenshots**

Capture light-mode screenshots at zoom 1 and 0.75. Use them for human design
review, with a narrow max-diff threshold only after fonts and platform rendering
are stable in CI.

**Step 4: Write the real-Tauri manual checklist**

Cover Retina font rendering, trackpad pan/zoom, click-versus-drag, editor focus,
clipboard actions, window resize, menu clamping, and dense-board scanability.

**Step 5: Run the full gate**

```bash
npm run check
npm run test:e2e
cargo test --offline --manifest-path src-tauri/Cargo.toml
```

Expected: all existing and new checks pass.

**Step 6: Run the craft checks**

- Squint: chrome recedes and object classes stay distinguishable.
- Swap: replacing Portal with a generic white card would obviously weaken the design.
- Signature: Portal grammar appears in tile, title, counts, hover, selection, and drop target.
- AI-slop score: no gradients, bubbly Cards, emoji icons, decorative blobs, or generic dashboard layout.
- Token: no new raw palette values appear in component CSS.

**Step 7: Commit**

```bash
git add src/test src/services/mock-workspace-gateway.ts tests/e2e/visual-shell.spec.ts docs/testing/visual-shell-manual.md
git commit -m "test: lock the dense visual shell"
```

## Implementation order and parallelization

```text
Task 1 tokens
      ↓
Task 2 shell
      ↓
Task 3 icons ─────────────┐
      ↓                   │
Task 4 rail               │
      ↓                   │
Task 5 top navigation     │
      ↓                   │
Task 6 canvas theme       │
      ├──────── Task 7 Portals
      ├──────── Task 8 Cards
      └──────── Task 9 Menu
                    ↓
             Task 10 acceptance
```

Tasks 7, 8, and 9 may run in parallel worktrees after Tasks 1–6 land because
they own separate component directories. Task 10 starts only after all three merge.

## Handoff to the next product slices

After this plan passes visual acceptance:

1. specify and implement browser-like Board tabs;
2. implement Quick Boards on the now-stable top-bar boundary;
3. add contextual rail state and Note/Portal appearance tools;
4. add mandatory Search without changing the spatial Home model.
