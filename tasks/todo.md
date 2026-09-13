# Todo

## Active handoff — Folder Shortcut V1 (2026-09-09)

- [x] Checkpoint Tasks 1–6 on `codex/folder-shortcut-v1` through commit `cabdcaa`:
  schema/DTOs, macOS bookmark boundary, commands/projections, gateway/mock,
  native Finder drop routing, and the initial resizable blue Folder Card.
- [x] Task 7 integrated and committed: Search by display name/path hint, Trash
  title/kind/restore, Unsorted alias preview, context-menu Show in Finder, and
  exhaustive Card-kind boundaries (`041bf0e`).
- [x] Backend correctness gaps closed and committed: SQLite mutex no longer held
  across filesystem I/O, balanced security-scoped access via RAII guard, image
  MIME/SVG drop classification preserved, ID replay implemented, refreshed
  identity on stale previews, and expanded service/migration coverage
  (`d73b53f`, `e74486e`, `200da0c`).
  **Superseded (2026-09-11):** the security-scoped RAII guard was removed. The app
  is not sandboxed, so security-scoped bookmark creation fails on current macOS;
  locators are now plain bookmarks (ADR-0006).
- [x] Task 8 E2E + manual docs committed (`test: verify folder shortcut lifecycle`).
- [ ] Packaged macOS Finder-drop/restart/move/open acceptance and comparison to
  the approved PNG remain a manual step for a signed build; `tauri dev` is not
  bookmark-durability evidence.

## Current V1 delta — 2026-09-05

- [x] Add the reversible Trash UI: fixed bottom-left button, non-zero batch
  count, batch inspection, and batch restore (commit range `7cee4ee..41fa1d1`).
  Permanent Empty Trash and asset GC remain a separately confirmed destructive
  slice (see backlog #8).
- [ ] Add mandatory Search after the reversible Trash UI. Spec drafted in
  `docs/specs/search.md`; three scope decisions (global vs current board,
  ranking, highlight) are OPEN and must be agreed before implementation.

### 2026-09-08 — Search UX + contextual note rail + group move (architect slices 1–4)

- [x] Search: highlight matches in snippets, group results by board (cover/icon/
  acronym + path + count), top-bar search field, navigation + center + select,
  and transient in-card highlight (Tiptap decoration, not persisted).
- [x] Contextual note rail (`create`/`note` modes) with Bold, text color, and note
  background color. Note color = semantic preset persisted in the backend
  (migration `0011`, `set_note_color`), does not bump the text revision.
- [x] Group move: a dragged multi-selection moves together onto a board portal,
  breadcrumb, or board tab (leaf cards -> Unsorted batch; boards reparent).
  Commit range `7bf3f71..d1eff45`.

- [x] Add real Link Card metadata enrichment with bounded HTTP, YouTube/Open Graph support, and persisted fallback states.
- [x] Cache preview and favicon files as managed assets.
- [x] Auto-grow enriched Link Cards so preview, title, and description are visible without manual resize.
- [x] Add empty-canvas double-click Note creation at the board-space cursor position.
- [x] Fix breadcrumb projection to `Home / … / Current Board` and make every crumb navigable.
- [x] Add atomic, undoable Board reparenting (backend `move_board` + `MoveBoardCommand`).
- [x] Wire Board reparenting to canvas DnD: drop Board Portals onto Board Portals.
- [x] Wire breadcrumbs as drop targets for leaf cards and Board Portals.
- [x] Extend mock navigation for nested-board e2e and add hierarchy acceptance coverage.
- [x] Let Note, Image, and Link Cards move to breadcrumb ancestors through the existing leaf-card command.
- [ ] Verify clean live Link Card auto-fit and YouTube channel Retry outside hot reload.
- [x] Harden startup snapshots: validate DB/assets, publish atomically, and rate-limit normal dev-start backups.
- [x] Add and rehearse a restore flow that preserves the damaged live database/assets before replacement.
- [ ] (optional) Expose a manual restore command in the UI/CLI.
- [ ] Add explicit clipboard replacement for Link previews and Board Portal covers.
- [ ] Implement asset garbage collection for permanently deleted cards.
- [ ] Continue the Milanote-like left rail, top navigation, contextual formatting, and Search from `docs/plans/2026-09-04-spatial-workspace-interface.md`.
- [x] Add visible Undo/Redo controls to the top-right command group. Reuse the
  existing `CommandDispatcher` and `Command-Z` handlers; include accurate disabled
  states and keep Tiptap text undo ownership while an editor has focus.
- [x] Add session-only collapse/expand behavior to the vertical Quick Boards rail;
  keep the collapsed edge available as a Board Portal drop target.
- [ ] Implement the accepted Quiet Desk visual shell and dense-board acceptance gate from `docs/plans/2026-09-05-quiet-desk-visual-shell.md`.

## Backlog — user-requested features (not yet scheduled)

Status key: `next` = scheduled after its listed prerequisites; `discuss` = needs another
architecture pass before sizing; `blocked` = depends on another item.

### 1. Agent surface — address a Board / pass it to an agent

- `next` — A Board is addressed by stable `myspace://board/<id>`, not a filesystem
  path. A concrete Rust `WorkspaceService` owns typed queries/commands; Tauri and a
  local MCP-over-stdio server are adapters. Full decision and safety gates are in
  `docs/decisions/0005-provider-agnostic-agent-surface.md`.
- User intent (verbatim intent): an agent should be able to *add* 10 YouTube links
  into a Board (they become Link Cards with previews), and conversely the user
  builds a Board of screenshots/notes/links and hands it to an agent to read.
- Sub-request: "copy path to object" (right-click) — a real file path exists per
  asset (`assets/<asset_id>.*`), so per-object path is straightforward; per-board
  path is NOT (no folder).
- Related: `tasks/lessons.md` north-star already records "agent acts through the
  same typed domain commands as the UI, not direct SQLite".
- Safety gate: agent writes remain disabled until validated backup restore,
  idempotency, durable batch identity, and cross-process UI refresh exist.

### 2. Clipboard copy of selection

- `next` — Minimal slice: select several images/notes, `Cmd+C` / right-click → copy
  the selected **images** into the system clipboard (macOS image data), paste into
  any app/agent/folder. Uses the existing selection contract.
- `discuss` — Rich form: copy "note text + N images" as one clipboard payload
  (text + attachments). macOS clipboard multipart has limits; likely to be resolved
  via item 1 (give the agent the board instead). Defer until item 1 is decided.

### 3. Browser-like board tabs

- `next` — Tabs like a browser: open several boards, switch quickly, close a tab
  without deleting the board. Distinct from Quick Boards (pinned bookmarks in the
  top bar, already in the UI plan).
- `next` (ideal, Finder-like) — drag a card/file between two open board tabs to
  move it, like Finder tabs. Depends on tabs existing.

### 4. Real filesystem shortcuts (folder/file aliases)

- `in progress` — Drag-and-drop a real macOS folder onto a Board to create a **folder
  shortcut** (no copying): a card that shows its live contents (list of files and
  subfolders) and a small "reveal in Finder" action (open the folder; opening a
  file reveals it selected in Finder). For files, drag creates a **file card**
  (copied into the managed asset store) with a preview (text/MD/JSON/table) and an
  open-in-external-app action.
- **Drop rule (default)**: folder → shortcut; file → copied file card. Hold `⌥`
  while dropping a file to create an alias shortcut instead (for heavy files like
  video that should not be duplicated). All interaction is drag-and-drop.
- Same external-world theme as item 1 — recommend one combined architecture pass
  (folder listing, file-type detection, preview rendering, "open in Finder").

### 5. Unsorted side panel (Milanote-style)

- `later` — When cards are dropped into a Board without opening it, they land in an
  "Unsorted" side panel that appears only when such incoming objects exist, rather
  than stacking invisibly at the board origin. Part of the left-rail UI plan
  (`docs/plans/2026-09-04-spatial-workspace-interface.md`). Not started; the current
  fix just places drops at a free slot below existing cards.

### 6. Board icon/color/cover editing

- `later` — Let the user change a Board Portal's icon/cover, with clipboard image
  paste and file selection as the first two inputs. Currently the portal only has a
  deterministic color token and a text symbol derived from the title; there is no
  persisted cover image or icon asset yet (`src/cards/board/BoardPortalCard.tsx`,
  `src-tauri/src/domain/models.rs`).
- `later` — Keep this in the portal-context rail and tile context menu. The action
  should support `Set Cover from Clipboard`, `Choose Cover…`, and `Remove Cover`,
  falling back to the color/symbol tile when no image is set.
- `later` — Clipboard support for cover replacement is part of the clipboard slice
  (see `docs/specs/link-card-and-clipboard.md`). Not started.

### 7. Copy MySpace Link / Copy File Path

- `done` — Right-click a card: "Copy MySpace Link" copies `myspace://board/<id>`
  for Board Portals (the board it leads to) and `myspace://card/<id>` for Note /
  Image / Link cards. Image cards also offer "Copy File Path" (real
  `assets/<id>.*` path via `resolve_asset_path`). Clipboard writes go to
  `NSPasteboard` (macOS) through a backend `copy_text_command`, with a Web
  Clipboard fallback in browser mode. MCP gained `read_card` so a copied
  `myspace://card/<id>` is not a dead link.
- `next` (follow-up) — a direct "Copy MySpace Link" affordance for the
  *currently open* board (empty-canvas or breadcrumb right-click); the card-level
  slice is done. Also: asset links in the UI (`myspace-asset://` vs real path).

### 8. Empty Trash + asset garbage collection

- `planned` — detailed TDD plan:
  `docs/plans/2026-09-06-trash-view-and-empty-trash.md`. Soft-delete marks
  `deleted_at`/`trash_batch_id` but never removes files from `assets/` (on purpose,
  so Undo/restore keep working).
- `done` (reversible slice) — fixed bottom-left Trash button with non-zero batch
  count, a full drawer for inspecting/restoring deleted work, batch-level restore
  (mixed selections and Board subtrees are one atomic unit), and keyboard/focus
  handling. Backend `list_trash` read model groups by `trash_batch_id` and shows
  only top-level representatives. Commit range `7cee4ee..41fa1d1`.
- `next` (destructive slice) — permanently confirmed "Empty Trash" that
  hard-deletes trashed cards/detail rows + boards, then runs **mark-and-sweep GC**
  over assets still referenced by no active `image_cards`/`embed_cards` (delete
  file first, then metadata row; a missing file counts as success), with a
  startup sweep to finish interrupted deletions. Reference: `tasks/todo.md` item
  "Implement asset garbage collection", ADR-006, and the architect's GC guidance
  (refcount not needed; mark-and-sweep is sufficient).
- Confirmed safety decisions: restore operates on complete Trash batches (a mixed
  selection or Board subtree is one atomic unit); permanent emptying requires a
  fresh validated backup, explicit dialog, and typed `EMPTY`; asset GC follows
  relational deletion and is retried on startup.

### 9. Quiet Desk visual shell (design slice)

- `done` — accepted design from `.interface-design/system.md` (Quiet Desk, Retina
  smoothing, dense-board rules). Implemented across slices: tokens, AppShell
  (top bar + fixed rail + canvas), outline icons, creation rail (incl. drag-to-
  create), top navigation (breadcrumbs/Search/Undo/Redo), Desk theme + React Flow
  defaults neutralized, Portal/card material grammar, note/text colors, and the
  type-aware context menu (extracted to `components/context-menu`). Dense-board
  acceptance locked with `tests/e2e/visual-shell.spec.ts` + `?fixture=dense` and
  `docs/testing/visual-shell-manual.md`.
- Supersedes Tasks 1–5, 9, and the visual-acceptance part of Task 12 of
  `docs/plans/2026-09-04-spatial-workspace-interface.md`. Locked decisions:
  macOS system font (no web font), top bar `44px`, rail `56px`, breadcrumbs as the
  navigation anchor, no dead controls, default rail Note/Link/Board/Image.
- `wishlist` — contextual left rail hover modes beyond the current select-to-context
  (e.g. hover-intent handoff) and any further donor-app styling refinements.

### 10. Card connections (arrows between cards)

- `wishlist` — Milanote-style arrows: single-click a card to show a handle in its
  top-right corner; drag the handle onto another card to draw an arrow from the
  source center to the target center, clipped to each card's outline (the line is
  hidden outside both card bounds) and pointing at the target center, re-routing
  as either card moves. A dashed line from the source center only shows while the
  source card is selected. This is a large separate slice: a `connections`
  migration + backend commands, gateway/state, an SVG overlay above React Flow,
  and the drag-to-connect interaction.

### 11. Grouping (combine cards into a fixed group)

- `wishlist` — select several cards, then combine them into a persistent group
  (give it a name + color), like Obsidian/Milanote. The group moves/translates as
  one unit, can be resized, and accepts new members; its members keep their
  relative layout. A marquee-style selection frame already exists; a small
  context menu on selection would offer "Group". Needs a `groups` entity
  (migration), backend commands, and group rendering/interaction.

### 12. Favicon deduplication

- `wishlist` — link enrichment currently stores a separate favicon per Link Card,
  so 10 YouTube links yield 10 identical YouTube favicons. Introduce a shared
  favicon registry: for common hosts (e.g. YouTube) reuse one stored favicon
  instead of saving duplicates, and collapse existing duplicates. Same
  mark-and-sweep/refcount-free cleanup as asset GC.

## Ordering decision

1. Finish the current block: breadcrumb order (✅), breadcrumb navigation (✅),
   Board reparenting + DnD (Tasks 3–7 from
   `docs/plans/2026-09-05-board-hierarchy-breadcrumb-dnd.md`).
2. Safety gate for the live workspace: validated/atomic snapshots, retention that
   survives rapid dev restarts, and one rehearsed restore path.
3. ✅ Add a concrete Rust `WorkspaceService` + direct Link creation (batch) +
   ✅ MCP read-Board / list-boards / batch-add-Links vertical slice over stdio.
   ✅ cross-process refresh (get_data_version + frontend polling).
   ✅ durable batch undo (trash_links).
   ✅ asynchronous Link enrichment (enrich_links).
   ✅ MCP read_card + Copy MySpace Link / Copy File Path (stable entity
   addressing resolves `myspace://card/<id>` back to content).
   Remaining refinement: durable batch identity is a receipt table; agent write
   confirmation UX is the UI's concern, not the protocol slice.
4. Browser-like board tabs + Quick Boards, then clipboard copy of images.
5. Then (explicitly recorded, in this order):
   a. Empty Trash + asset garbage collection (backlog #8; irreversible, so
      confirm the two open UX decisions before coding);
   b. Quiet Desk visual shell (backlog #9, `docs/plans/2026-09-05-quiet-desk-visual-shell.md`),
      then its handoff slices (contextual rail, Search).
6. Filesystem shortcuts after the external addressing/access model is proven; do
   not add a speculative card kind to the schema now.
