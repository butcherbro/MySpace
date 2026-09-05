# Spatial Workspace Interface Implementation Plan

> Hierarchy/navigation addendum: root-first clickable breadcrumbs and Finder-like
> Board reparenting through Board Portal and breadcrumb drops are specified in
> `docs/plans/2026-09-05-board-hierarchy-breadcrumb-dnd.md`. That plan is the
> authoritative implementation order for hierarchy changes and must be completed
> before final visual-polish acceptance.

**Goal:** Replace the prototype web-app toolbar with a Milanote-like, Mac-native spatial shell: a dynamic left tool rail, a navigation-only top bar, deliberate card styling, mandatory search, and safe extension points for Quick Boards and future card metadata.

**Architecture:** Keep `App.tsx` as the orchestration boundary while extracting visual chrome into small tested components. Put all visual constants in shared design tokens, keep React Flow behind `CanvasAdapter`, and model rail context explicitly so hover-to-toolbar handoff is stable. Ship the shell and card polish first; add persisted note colors and search as independent vertical slices; reserve Quick Boards and tags in interfaces and documentation without rendering fake controls.

**Tech Stack:** Tauri 2, React 19, TypeScript, CSS custom properties, React Flow, Tiptap, Vitest, Testing Library, Playwright, Rust, SQLite.

---

## Sources of truth

- Product and interaction plan: `docs/plans/2026-08-28-visual-workspace-v1.md`
- Visual system: `.interface-design/system.md`
- Link and clipboard contract: `docs/specs/link-card-and-clipboard.md`
- Scope ADR: `docs/decisions/0001-v1-scope.md`
- Current shell: `src/App.tsx`, `src/app/AppShell.tsx`, `src/App.css`, `src/app/app-shell.css`

If this plan conflicts with the visual system, the visual system controls appearance and this plan controls implementation order.

## Locked decisions

1. The top bar is navigation-only: breadcrumbs on the left; Search, Undo, and Redo on the right.
2. The breadcrumb `Home` is the only root-workspace control and is always clickable. Remove the separate prototype Home button.
3. Quick Boards will eventually sit after breadcrumbs like browser bookmarks, but remain invisible until implemented.
4. Note, Link, Board, and Image creation live in the left rail.
5. The rail changes tools for the hovered/selected object without changing width or position.
6. Hover context uses an intent delay and grace period; pure CSS `:hover` is not sufficient.
7. Search is mandatory and must navigate back to the spatial object, not become a parallel document browser.
8. Tags and Quick Boards are deferred. Their future extension points must not create visible dead UI.
9. Use one coherent SVG icon family through a local wrapper. Do not use emoji.
10. A semantically empty Note containing exactly one web URL converts to a persisted Link Card on Enter or blur. Mixed text and multiple URLs remain Notes with inline links.
11. Once created, a Link Card keeps its type while its rich-text body grows. Bold ships first; text color, marker highlight, and whole-Note color remain separate concepts.

## Scope sequence

- **Interface Slice A:** design tokens, shell, top bar, left creation rail.
- **Interface Slice B:** stable contextual rail behavior and Note color tools.
- **Interface Slice C:** card visual grammar and creation placement.
- **Interface Slice D:** mandatory global search.
- **Interface Slice E:** screenshot acceptance and real Tauri trackpad/manual checks.
- **Deferred:** Quick Boards persistence/drop target, tags/filtering, advanced image and multi-select context tools.

### Task 1: Establish shared visual tokens

**Files:**

- Create: `src/styles/tokens.css`
- Create: `src/styles/global.css`
- Modify: `src/main.tsx`
- Modify: `src/App.css`
- Test: `src/app/AppShell.test.tsx`

**Step 1: Write a failing shell token test**

Add an assertion that the app shell carries `data-theme="system"` and exposes stable structural classes. Do not assert computed colors in JSDOM.

**Step 2: Run the focused test and verify failure**

Run: `npm test -- src/app/AppShell.test.tsx`

Expected: FAIL because the theme marker is absent.

**Step 3: Create the token files**

Copy the light tokens, typography, geometry, shadows, and a token-driven `prefers-color-scheme: dark` block from `.interface-design/system.md`. Use semantic names; card CSS must not own global palette values.

`global.css` owns reset, root sizing, body background, font smoothing, and shared focus-visible behavior. Remove Vite-template global button styling from `App.css`.

**Step 4: Import styles once**

In `src/main.tsx`, import in this order:

```ts
import "./styles/tokens.css";
import "./styles/global.css";
import "./App.css";
```

Do not import global files from individual card components.

**Step 5: Add the theme marker and run tests**

Run: `npm test -- src/app/AppShell.test.tsx && npm run typecheck`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/styles src/main.tsx src/App.css src/app/AppShell.test.tsx
git commit -m "style: establish spatial workspace tokens"
```

### Task 2: Convert the shell to top-bar plus left-rail geometry

**Files:**

- Modify: `src/app/AppShell.tsx`
- Modify: `src/app/app-shell.css`
- Modify: `src/app/AppShell.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.css`

**Step 1: Write the failing layout test**

Assert that `AppShell` exposes named slots for `topBar`, `toolRail`, and canvas content:

```tsx
render(
  <AppShell topBar={<div>Trail</div>} toolRail={<div>Tools</div>}>
    <div>Canvas</div>
  </AppShell>,
);

expect(screen.getByTestId("top-bar-region")).toHaveTextContent("Trail");
expect(screen.getByTestId("tool-rail-region")).toHaveTextContent("Tools");
expect(screen.getByTestId("canvas-region")).toHaveTextContent("Canvas");
```

**Step 2: Verify failure**

Run: `npm test -- src/app/AppShell.test.tsx`

Expected: FAIL because `AppShell` only accepts children.

**Step 3: Change the component contract**

Use this boundary:

```ts
interface AppShellProps {
  topBar: ReactNode;
  toolRail: ReactNode;
  children: ReactNode;
}
```

Render a two-row/two-column CSS grid. The top bar spans both columns; the rail occupies the left column; the canvas occupies the remaining cell.

**Step 4: Implement exact geometry**

- row 1: `44px`
- row 2: `minmax(0, 1fr)`
- column 1: `56px`
- column 2: `minmax(0, 1fr)`
- window: `100vw × 100vh`, overflow hidden

Remove the standalone `MySpace` web header. The native window title is sufficient for V1.

**Step 5: Adapt `App.tsx` without changing behavior**

Move existing buttons and breadcrumbs into temporary slot content. Do not restyle cards in this task.

**Step 6: Verify**

Run: `npm test -- src/app/AppShell.test.tsx src/app && npm run typecheck`

Expected: PASS.

**Step 7: Commit**

```bash
git add src/app src/App.tsx src/App.css
git commit -m "refactor: define spatial app shell regions"
```

### Task 3: Add a local icon boundary

**Files:**

- Create: `src/components/icons/Icon.tsx`
- Create: `src/components/icons/icon.css`
- Create: `src/components/icons/Icon.test.tsx`
- Optional after dependency security review: modify `package.json`, `package-lock.json`

**Step 1: Decide the source safely**

Prefer a small vetted outline icon dependency only after the required external dependency audit. If no dependency is approved, place project-owned SVG path data behind the same `Icon` component. Do not paste random SVGs from search results.

**Step 2: Write a failing accessibility test**

```tsx
render(<Icon name="note" label="New note" />);
expect(screen.getByLabelText("New note")).toBeInTheDocument();
```

Also cover decorative mode with `aria-hidden="true"`.

**Step 3: Implement the semantic map**

Support only the icons needed now: `note`, `link`, `board`, `image`, `search`, `undo`, `redo`, `back`, and `bookmark`.

**Step 4: Verify icon consistency**

Every icon renders in a `20×20` view box wrapper, inherits `currentColor`, and has no per-icon inline colors.

Run: `npm test -- src/components/icons/Icon.test.tsx && npm run typecheck`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/icons package.json package-lock.json
git commit -m "feat: add accessible workspace icon boundary"
```

### Task 4: Build the default creation rail

**Files:**

- Create: `src/components/tool-rail/ToolButton.tsx`
- Create: `src/components/tool-rail/ToolRail.tsx`
- Create: `src/components/tool-rail/tool-rail.css`
- Create: `src/components/tool-rail/ToolRail.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/app/AppShell.tsx`

**Step 1: Write failing behavior tests**

Render the rail with four callbacks and verify:

- accessible buttons appear in order: New note, Add link, New board, Add image;
- each callback fires exactly once;
- tooltips expose shortcuts for Note and Board;
- the rail has `aria-label="Creation tools"`.

**Step 2: Verify failure**

Run: `npm test -- src/components/tool-rail/ToolRail.test.tsx`

Expected: FAIL because the component does not exist.

**Step 3: Implement the stable component contract**

```ts
interface ToolRailProps {
  mode: "create" | "note-context";
  onCreateNote: () => void;
  onAddLink: () => void;
  onCreateBoard: () => void;
  onAddImage: () => void;
  noteContext?: NoteContextModel;
}
```

Do not add future mode buttons yet. The union may be extended when functionality exists.

**Step 4: Apply the exact visual contract**

- fixed `56px` width inherited from shell;
- `48px` rows;
- 20px icons;
- no generic bordered button boxes at rest;
- subtle surface on hover;
- clear focus-visible state;
- active press moves at most 1px;
- labels may be visually present at 10px but must not make the rail wider.

**Step 5: Move creation actions from the top**

Pass existing `handleCreateNote`, `handleCreateChildBoard`, and `handleCreateImage` callbacks from `App.tsx`. Add Link as an explicit callback boundary; until Link creation exists, either omit it from the shipping rail or implement the minimal URL capture slice before showing it. Do not render a dead button.

**Step 6: Verify existing interactions**

Update queries in component/e2e tests from the top toolbar to accessible button names; names must remain stable.

Run: `npm test && npm run test:e2e`

Expected: all existing tests PASS.

**Step 7: Commit**

```bash
git add src/components/tool-rail src/App.tsx src/app tests/e2e
git commit -m "feat: move creation tools into left rail"
```

### Task 4.1: Implement automatic Link Card conversion and clipboard preview replacement

**Files:**

- Create: `src/cards/link/LinkCard.tsx`
- Create: `src/cards/link/link-card.css`
- Create: `src/cards/link/LinkCard.test.tsx`
- Create: `src/cards/link/link-conversion.ts`
- Create: `src/cards/link/link-conversion.test.ts`
- Modify: `src/cards/card-registry.tsx`
- Modify: `src/editor/NoteEditor.tsx`
- Modify: `src/editor/NoteEditor.test.tsx`
- Modify: `src/services/workspace-gateway.ts`
- Modify: `src/services/mock-workspace-gateway.ts`
- Modify: `src/services/tauri-workspace-gateway.ts`
- Create: `src-tauri/migrations/0003_embed_card_content.sql`
- Modify: `src-tauri/src/domain/models.rs`
- Modify: `src-tauri/src/repositories/workspace_repository.rs`
- Create: `src-tauri/src/commands/link_commands.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/App.tsx`
- Modify: `src/state/current-board-store.ts`
- Modify: `tests/e2e/canvas-smoke.spec.ts`

Read `docs/specs/link-card-and-clipboard.md` completely before implementation.

**Step 1: Write failing predicate tests**

Cover one URL, outer whitespace, empty trailing paragraphs, mixed text, malformed URL, multiple URLs, lists, and embedded content. The predicate accepts only one absolute HTTP(S) URL.

**Step 2: Verify failure**

Run: `npm test -- src/cards/link/link-conversion.test.ts`

Expected: FAIL because the predicate does not exist.

**Step 3: Implement the pure predicate**

Keep URL classification independent from React and Tiptap view instances. Accept normalized serializable document data and return either `{ qualifies: true, url }` or a typed rejection reason.

**Step 4: Write failing transactional repository tests**

Cover preserving card id/frame/z-index, one revision increment, undo restoration, metadata failure fallback, and atomicity. A failed conversion must leave the original Note untouched.

**Step 5: Add the persisted Link Card shape**

Extend the existing `embed_cards` table and Rust `EmbedCardDto`; do not create a parallel `link_cards` table or `link` card kind. Persist source URL, title, and the Link Card's versioned rich-text body separately from Note `documentJson`. Keep the existing nullable `asset_id` as the active preview; add a separate nullable `favicon_asset_id` and a small `preview_origin` value so metadata refresh cannot overwrite a custom preview. Do not add a third hidden preview asset in V1.

**Step 6: Implement the conversion command**

`convertNoteToLink` must execute in one SQLite transaction. It creates `embed_cards` details, changes `cards.kind` from `note` to `embed`, removes Note details, and returns the authoritative `EmbedCardDto`. Make it an undoable workspace command.

**Step 7: Trigger only on finalize intent**

In the editor boundary, Enter or blur requests conversion only when the pure predicate succeeds. Any additional semantic content cancels conversion. Do not add an idle conversion timer.

**Step 8: Implement bounded metadata acquisition**

Fetch through Rust with scheme validation, redirect/time/size limits, generic Open Graph extraction, favicon fallback, and durable managed-asset caching. Audit every new external dependency before installation. A fetch failure returns a usable fallback card.

**Step 9: Render the visual hierarchy**

Render edge-to-edge preview, favicon/source row, clickable title, and editable rich-text body using `.interface-design/system.md`. Reuse the shared editor and draft lifecycle. Register the type through `card-registry`; do not add Link-specific branches to `CanvasAdapter`.

**Step 10: Implement explicit clipboard replacement**

Add `Replace from Clipboard`, `Choose Image…`, and `Remove Preview` commands. Clipboard images become managed assets and replace the preview only after a successful transactional update.

**Step 11: Add Board cover clipboard commands through the same asset path**

Add `Set Cover from Clipboard`, `Choose Cover…`, and `Remove Cover` to Portal context actions. Reuse asset import and validation; do not duplicate clipboard decoding.

**Step 12: Verify end-to-end boundaries**

Add e2e cases for single URL conversion, mixed content remaining a Note, two URLs remaining a Note, rich-text body edits without kind changes, Bold persistence, offline fallback, preview replacement persistence, Board cover replacement persistence, and undo conversion.

Run:

```bash
npm test
npm run test:e2e
cargo test --manifest-path src-tauri/Cargo.toml
npm run typecheck
```

Expected: all commands exit 0.

**Step 13: Commit**

```bash
git add src/cards/link src/cards/board src/editor src/services src/state src/App.tsx src-tauri tests/e2e
git commit -m "feat: add editable link previews and clipboard covers"
```

### Task 5: Build the navigation-only top bar

**Files:**

- Create: `src/navigation/TopNavigationBar.tsx`
- Create: `src/navigation/top-navigation-bar.css`
- Create: `src/navigation/TopNavigationBar.test.tsx`
- Create: `src/navigation/QuickBoardsSlot.tsx`
- Modify: `src/navigation/BoardBreadcrumbs.tsx`
- Modify: `src/navigation/board-breadcrumbs.css`
- Modify: `src/App.tsx`

**Step 1: Write failing structure tests**

Verify:

- breadcrumbs are first;
- Home is rendered as an enabled breadcrumb action even while Home is current;
- no standalone Home button exists outside the breadcrumb trail;
- the empty Quick Boards slot does not consume visible width;
- Search, Undo, and Redo are at the right;
- Undo/Redo expose disabled states;
- no creation action exists in the top bar;
- the current Board title is not repeated outside breadcrumbs.

**Step 2: Verify failure**

Run: `npm test -- src/navigation/TopNavigationBar.test.tsx`

Expected: FAIL because the component does not exist.

**Step 3: Implement the component API**

```ts
interface TopNavigationBarProps {
  breadcrumbs: Breadcrumb[];
  onNavigate: (boardId: string) => void;
  onOpenSearch: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  quickBoards?: ReactNode;
}
```

Do not read dispatcher state directly from the visual component.

**Step 4: Integrate breadcrumbs**

Remove their independent white row and border. Breadcrumbs become part of the 44px top bar. Preserve the existing deep-path collapse behavior and tests. Change the current implementation, which disables the final breadcrumb, so the root `Home` crumb remains enabled and calls `onNavigate(homeId)` even when Home is current. Remove `workspace__home` and its standalone button from `App.tsx`.

**Step 5: Connect history controls**

Expose `canUndo` and `canRedo` from `CommandDispatcher` through an observable application state or a small adapter. Do not render controls as active when no command can run.

**Step 6: Add the hidden future slot**

`QuickBoardsSlot` returns `null` for an empty list. It exists to keep future bookmarks out of `TopNavigationBar` internals; do not add persistence or a drop target now.

**Step 7: Verify**

Run: `npm test -- src/navigation && npm run typecheck`

Expected: PASS.

**Step 8: Commit**

```bash
git add src/navigation src/App.tsx src/commands
git commit -m "feat: add navigation-only top bar"
```

### Task 6: Model stable contextual rail state

**Files:**

- Create: `src/components/tool-rail/tool-rail-state.ts`
- Create: `src/components/tool-rail/tool-rail-state.test.ts`
- Create: `src/components/tool-rail/use-contextual-tool-rail.ts`
- Create: `src/components/tool-rail/use-contextual-tool-rail.test.tsx`
- Modify: `src/canvas/canvas-types.ts`
- Modify: `src/canvas/CanvasAdapter.tsx`
- Modify: `src/App.tsx`

**Step 1: Write failing reducer tests**

Cover this state machine:

```text
create
  └─ hover intent 120ms ─> note-context(transient)
note-context(transient)
  ├─ enter rail ─────────> note-context(bridged)
  ├─ select/edit ────────> note-context(pinned)
  └─ leave both 400ms ───> create
note-context(pinned)
  └─ Escape/clear ───────> create
```

Rapid `hover(note A) → hover(note B) → leave` must not leave stale timers or the wrong target id.

**Step 2: Verify failure**

Run: `npm test -- src/components/tool-rail/tool-rail-state.test.ts`

Expected: FAIL because the state model does not exist.

**Step 3: Implement a pure reducer first**

The pure state stores `mode`, `targetCardId`, and `pinned`. Timers stay in the hook, not the reducer.

**Step 4: Add semantic hover events to CanvasAdapter**

Extend the application-owned Canvas event boundary with:

```ts
onCardHoverChanged?: (event: { cardId: string; kind: CanvasCard["kind"] } | null) => void;
```

Do not import tool-rail state into `CanvasAdapter`.

**Step 5: Implement timer cleanup**

The hook must cancel both intent and grace timers on target changes and unmount. Entering the rail cancels the grace timer.

**Step 6: Pin selected/editing Notes**

Selection and `editingCardId` from application state take precedence over transient hover. Mixed or multi-selection stays in `create` until multi-selection tools exist.

**Step 7: Verify**

Run: `npm test -- src/components/tool-rail src/canvas/CanvasAdapter.test.tsx && npm run typecheck`

Expected: PASS with fake timers and no act warnings.

**Step 8: Commit**

```bash
git add src/components/tool-rail src/canvas src/App.tsx
git commit -m "feat: add stable contextual tool rail state"
```

### Task 7: Persist Note background color

**Files:**

- Create: `src/cards/note/note-appearance.ts`
- Create: `src/cards/note/note-appearance.test.ts`
- Modify: `src/services/workspace-gateway.ts`
- Modify: `src/services/mock-workspace-gateway.ts`
- Modify: `src/services/tauri-workspace-gateway.ts`
- Create: `src-tauri/migrations/0003_note_appearance.sql`
- Modify: `src-tauri/src/domain/`
- Modify: `src-tauri/src/repositories/workspace_repository.rs`
- Modify: `src-tauri/src/commands/`
- Modify: `src/cards/note/NoteCard.tsx`
- Modify: `src/cards/note/note-card.css`
- Modify: `src/components/tool-rail/ToolRail.tsx`
- Create: `src/components/tool-rail/NoteContextTools.tsx`
- Create: `src/components/tool-rail/NoteContextTools.test.tsx`

**Step 1: Lock the data contract in failing tests**

Use a closed token union, not arbitrary CSS:

```ts
type NoteColorToken = "paper" | "yellow" | "rose" | "blue" | "green" | "lilac";
```

Test DTO round-trip, optimistic update, stale revision rejection, and unknown-token rejection in Rust.

**Step 2: Verify failures**

Run focused frontend and Rust tests. Expected: FAIL because the field and command do not exist.

**Step 3: Add a safe migration**

Add a nullable/defaulted Note appearance field without rebuilding unrelated tables if SQLite permits the additive change. Existing Notes must resolve to `paper`.

**Step 4: Implement the typed command path**

Add `updateNoteAppearance` through gateway, Tauri command, repository, and reducer. It must use `expectedRevision` like content updates.

**Step 5: Render semantic classes**

Map tokens to classes or CSS variables owned by `note-appearance.ts`. Never persist hex values.

**Step 6: Build the rail popover**

Show six compact swatches, keyboard navigable, with `aria-label`s. The selected swatch has a visible check mark independent of color perception.

**Step 7: Verify**

Run: `npm test && cargo test --manifest-path src-tauri/Cargo.toml && npm run typecheck`

Expected: PASS.

**Step 8: Commit**

```bash
git add src/cards/note src/components/tool-rail src/services src-tauri
git commit -m "feat: add persisted note background colors"
```

### Task 8: Expose shared text formatting through the editor boundary

**Files:**

- Modify: `src/editor/editor-extensions.ts`
- Modify: `src/editor/NoteEditor.tsx`
- Modify: `src/editor/NoteEditor.test.tsx`
- Modify: `src/components/tool-rail/NoteContextTools.tsx`
- Modify: `src/App.tsx`

**Step 1: Write failing Bold command-state tests**

Use the Bold support already present in the approved StarterKit. Test toggle, active state, mixed selection state, `Command-B`, and persistence for both Note and Link Card body editors.

**Step 2: Expose Bold through an editor-owned command bridge**

The contextual rail must be able to request `toggleBold()` and observe whether Bold is active without importing Tiptap types.

**Step 3: Keep Tiptap types inside the editor module**

Expose application semantics such as:

```ts
interface RichTextEditorCommands {
  toggleBold(): void;
}
```

Implement only `toggleBold` now. Add text-color and highlight methods to this boundary later, together with their extensions and persistence tests. The tool rail must not import Tiptap editor types.

**Step 4: Gate text controls by focus**

Bold appears only while a Note or Link body editor owns focus. Background color remains available for a selected Note outside edit mode. Future text color and marker highlight also require editor focus or an active text selection.

**Step 5: Audit future color extensions before installation**

Before adding text-color or marker-highlight packages, run the external dependency security review. Keep their persisted tokens separate from the whole-Note `NoteColorToken`.

**Step 6: Verify**

Run: `npm test -- src/editor src/components/tool-rail && npm run typecheck`

Expected: PASS.

**Step 7: Commit**

```bash
git add src/editor src/components/tool-rail src/App.tsx package.json package-lock.json
git commit -m "feat: expose shared rich text controls"
```

### Task 9: Apply the card visual grammar

**Files:**

- Modify: `src/cards/note/note-card.css`
- Modify: `src/cards/image/image-card.css`
- Modify: `src/cards/board/board-portal-card.css`
- Modify: `src/cards/board/BoardPortalCard.tsx`
- Modify: `src/canvas/CanvasAdapter.tsx`
- Create: `src/canvas/canvas.css`
- Modify: `src/cards/note/NoteCard.test.tsx`
- Modify: `src/cards/image/ImageCard.test.tsx`
- Modify: `src/cards/board/BoardPortalCard.test.tsx`

**Step 1: Write failing semantic-state tests**

Assert explicit state attributes/classes for `hovered`, `selected`, `editing`, `dragging`, `saving`, and `error` where applicable. Do not infer important appearance only from React Flow classes.

**Step 2: Verify failure**

Run the three card test files. Expected: FAIL for missing state hooks.

**Step 3: Remove global magic colors**

Replace hard-coded card colors with tokens. Move `COLOR_VARS` out of `BoardPortalCard.tsx` into a typed portal appearance module or CSS semantic classes.

**Step 4: Style Notes as paper**

Apply 5px radius, `--shadow-paper`, 14px content type, restrained selection, and a resize handle visible only on hover/selection. Editing may strengthen the focus edge but must not add a thick blue halo.

**Step 5: Style Images as image-first objects**

Remove unnecessary framing when no caption exists. Keep a compact paper caption strip only when content or editing requires it.

**Step 6: Style Portals as doorways**

Keep the 60px tile and compact metadata footprint. Add hover lift and whole-footprint selection. Preserve double-click/Enter behavior.

**Step 7: Neutralize React Flow defaults**

Use `canvas.css` scoped under the workspace to override default node outlines, selection rectangle, and cursor states. Do not rely on brittle generated class names beyond documented React Flow classes.

**Step 8: Verify**

Run: `npm test -- src/cards src/canvas && npm run test:e2e`

Expected: PASS.

**Step 9: Commit**

```bash
git add src/cards src/canvas
git commit -m "style: establish spatial card grammar"
```

### Task 10: Place newly created objects in the visible workspace

**Files:**

- Create: `src/canvas/find-open-placement.ts`
- Create: `src/canvas/find-open-placement.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/canvas/CanvasAdapter.tsx`
- Modify: `src/canvas/canvas-types.ts`
- Modify: `tests/e2e/canvas-smoke.spec.ts`

**Step 1: Write failing placement tests**

Cover viewport-center conversion, 24px cascade, collision avoidance, and deterministic fallback. Include cards of different sizes.

**Step 2: Verify failure**

Run: `npm test -- src/canvas/find-open-placement.test.ts`

Expected: FAIL because the function does not exist.

**Step 3: Expose the visible Board rectangle**

Extend the Canvas boundary with an application-owned function that converts viewport center to Board coordinates. Keep React Flow instance types inside `CanvasAdapter`.

**Step 4: Implement deterministic open placement**

Start at visible center, then test positions on a 24px diagonal/ring until the new frame does not materially overlap an existing card. Cap attempts and use a deterministic fallback.

**Step 5: Apply by object type**

- Note: visible center, then enter edit mode.
- Board: visible center, then start inline rename.
- Image picker: visible center; Finder drop keeps exact pointer placement.
- Link: visible center with URL capture focused.

**Step 6: Add an e2e regression**

Create four Notes rapidly and assert their rectangles do not exactly coincide. This addresses the current prototype behavior where repeated cards obscure one another.

**Step 7: Verify**

Run: `npm test -- src/canvas tests/e2e/canvas-smoke.spec.ts && npm run test:e2e`

Expected: PASS.

**Step 8: Commit**

```bash
git add src/canvas src/App.tsx tests/e2e/canvas-smoke.spec.ts
git commit -m "feat: place new cards in visible open space"
```

### Task 11: Add the mandatory Search palette

**Files:**

- Create: `src/search/search-types.ts`
- Create: `src/search/SearchPalette.tsx`
- Create: `src/search/search-palette.css`
- Create: `src/search/SearchPalette.test.tsx`
- Modify: `src/services/workspace-gateway.ts`
- Modify: `src/services/mock-workspace-gateway.ts`
- Modify: `src/services/tauri-workspace-gateway.ts`
- Modify: `src-tauri/src/repositories/workspace_repository.rs`
- Modify: `src-tauri/src/commands/`
- Modify: `src/navigation/TopNavigationBar.tsx`
- Modify: `src/App.tsx`
- Modify: `src/state/current-board-store.ts`
- Modify: `src/canvas/CanvasAdapter.tsx`
- Modify: `tests/e2e/canvas-smoke.spec.ts`

**Step 1: Define and test the application result contract**

```ts
interface SearchResult {
  entityId: string;
  kind: "board" | "note";
  title: string;
  excerpt: string | null;
  boardId: string;
  boardTrail: Array<{ id: string; title: string }>;
}
```

The UI must not receive raw SQLite rows.

**Step 2: Write failing repository tests**

Cover Board-title matches, Note `plain_text` matches, case-insensitive behavior, empty query, result limit, trashed entity exclusion, and stable ordering.

**Step 3: Implement the simplest V1 query**

For current scale, use indexed/escaped `LIKE` queries over Board title and authoritative derived Note `plain_text`. Do not introduce FTS until measurements show it is needed.

**Step 4: Write failing palette tests**

Cover `Command-K`, input focus, 150ms query debounce, keyboard navigation, Escape, grouped results, Board trail display, and selection.

**Step 5: Implement the palette**

Render a `560px` surface below the top bar, clamp it to the window, and keep the canvas visible behind a light non-blocking scrim. Do not build a permanent search sidebar.

**Step 6: Implement spatial result activation**

On Note result:

1. load its Board snapshot;
2. set the viewport so the card is centered;
3. select the card;
4. apply a transient focus pulse;
5. leave edit mode off until the user clicks the Note.

On Board result: navigate to that Board's last saved viewport.

**Step 7: Verify end-to-end**

Add an e2e test that creates a Note with distinctive text, opens Search with `Command-K`, chooses it, and verifies the Note becomes selected and visible.

Run: `npm test && cargo test --manifest-path src-tauri/Cargo.toml && npm run test:e2e`

Expected: PASS.

**Step 8: Commit**

```bash
git add src/search src/services src/navigation src/state src/canvas src/App.tsx src-tauri tests/e2e
git commit -m "feat: add spatial workspace search"
```

### Task 12: Add screenshot and interaction acceptance gates

**Files:**

- Create: `tests/e2e/interface-visual.spec.ts`
- Create: `tests/e2e/interface-interactions.spec.ts`
- Modify: `playwright.config.ts`
- Create: `docs/qa/interface-manual-checklist.md`

**Step 1: Create deterministic visual fixtures**

Extend the mock gateway through an explicit fixture input so screenshots contain Notes, Images, and at least twelve Board Portals with stable ids, text, sizes, and positions. Do not seed production storage.

**Step 2: Capture the primary Retina viewport**

Use `1512×982` CSS pixels with `deviceScaleFactor: 2`. Capture:

- populated Home Board;
- nested Board with breadcrumbs;
- selected Note;
- Note contextual rail;
- Search palette;
- dark mode if implemented in the slice.

**Step 3: Assert structural visual requirements**

In addition to snapshots, assert:

- no top-bar creation buttons;
- rail width is 56px;
- top bar height is 44px;
- canvas begins directly after the rail/top bar;
- empty Quick Boards slot has zero visible footprint;
- default React Flow controls/minimap/attribution are absent.

**Step 4: Add rail handoff interaction coverage**

Use fake or controlled timers where possible. In browser e2e, hover a Note, move through the gap into the rail within the 400ms grace period, and verify Note tools remain available.

**Step 5: Create the real Mac manual checklist**

Document checks that browser automation cannot prove:

- two-finger pan and pinch comfort for ten minutes;
- click-release Note editing;
- click-hold-drag without accidental editing;
- pointer travel from Note to contextual rail;
- keyboard focus ownership between Tiptap, Search, and canvas;
- Retina crispness;
- native image picker and Finder drop.

**Step 6: Run full gates**

Run:

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all commands exit 0. Review every new screenshot manually; snapshot approval is not proof of design quality.

**Step 7: Commit**

```bash
git add tests/e2e playwright.config.ts docs/qa
git commit -m "test: lock spatial interface acceptance"
```

## Deferred extension contracts

### Quick Boards

Implement only after the core top bar is stable. Persistence should store ordered Board references separately from Board hierarchy and Board Shortcut cards. Dragging a Portal to the top bar creates a reference; it never moves the Board.

Expected future files:

- `src/navigation/QuickBoardsBar.tsx`
- `src/navigation/use-quick-board-drop.ts`
- `src-tauri/migrations/00xx_quick_boards.sql`
- repository and gateway commands for add, reorder, and remove

### Tags

Tags are future metadata used for search/filtering, not a replacement for spatial organization. Add the note-context button only when persistence, assignment, removal, and filtering are all functional.

Expected future files:

- `src/metadata/tags/TagPicker.tsx`
- `src/metadata/tags/tag-types.ts`
- repository and gateway commands for tag CRUD and assignment

### Additional contextual rail modes

Add one mode only when it has at least one real action. Preserve the stable rail container and hover handoff state machine.

## Delivery order for the coding agent

1. Tasks 1–5: shell, icons, creation rail, navigation bar.
2. Stop for a visual review in the real Tauri window.
3. Task 6: contextual state mechanics.
4. Tasks 7–8: Note background and text color, each as a separate data-safe slice.
5. Tasks 9–10: card polish and non-overlapping visible placement.
6. Stop for a second visual and interaction review.
7. Task 11: Search.
8. Task 12: final automated and manual acceptance gates.

Do not let Quick Boards or Tags delay Tasks 1–12.
