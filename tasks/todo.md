# Todo

## Current V1 delta — 2026-09-05

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

- `discuss` — Project a real macOS folder's contents onto the Board as a visual
  map (no copying), click to open in Finder. Icons/thumbnails preferred; readable
  preview of text/json is an ideal, not required. Alias file links too. Same
  external-world theme as item 1 — recommend one combined architecture pass.

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
  `docs/plans/2026-09-06-trash-view-and-empty-trash.md`. No Trash UI exists yet;
  soft-delete marks
  `deleted_at`/`trash_batch_id` but never removes files from `assets/` (on purpose,
  so Undo/restore keep working). The accepted UX is a fixed bottom-left Trash
  button with a non-zero batch count and a full drawer for inspecting and restoring
  deleted work. This reversible slice ships first. A separate later slice adds a
  permanently confirmed "Empty Trash" that
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

- `next` (recorded; start after the technical slices below) — the accepted design
  direction from `.interface-design/system.md` (Quiet Desk, Retina smoothing,
  dense-board rules). Full 10-step TDD plan in
  `docs/plans/2026-09-05-quiet-desk-visual-shell.md`: tokens → AppShell (top bar +
  fixed rail + canvas) → icon outline → creation rail → top navigation → Desk
  theme / neutralize React Flow defaults → Portal/card material grammar →
  type-aware context menu (preserving Copy/Delete) → dense-board visual acceptance.
- Supersedes Tasks 1–5, 9, and the visual-acceptance part of Task 12 of
  `docs/plans/2026-09-04-spatial-workspace-interface.md`, which remains the source
  for contextual rail behavior, Note appearance, shared rich-text tools,
  creation placement, and Search. Locked decisions:
  macOS system font (no web font), top bar `44px`, rail `56px`, breadcrumbs as the
  navigation anchor, no dead controls, default rail Note/Link/Board/Image.

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
