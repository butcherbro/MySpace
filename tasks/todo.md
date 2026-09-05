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
- [ ] Extend mock navigation for nested-board e2e and add hierarchy acceptance coverage.
- [ ] Let Note, Image, and Link Cards move to breadcrumb ancestors through the existing leaf-card command.
- [ ] Verify clean live Link Card auto-fit and YouTube channel Retry outside hot reload.
- [ ] Harden startup snapshots: validate DB/assets, publish atomically, and rate-limit normal dev-start backups.
- [ ] Add and rehearse a restore flow that preserves the damaged live database/assets before replacement.
- [ ] Add explicit clipboard replacement for Link previews and Board Portal covers.
- [ ] Implement asset garbage collection for permanently deleted cards.
- [ ] Continue the Milanote-like left rail, top navigation, contextual formatting, and Search from `docs/plans/2026-09-04-spatial-workspace-interface.md`.

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

## Ordering decision

1. Finish the current block: breadcrumb order (✅), breadcrumb navigation (✅),
   Board reparenting + DnD (Tasks 3–7 from
   `docs/plans/2026-09-05-board-hierarchy-breadcrumb-dnd.md`).
2. Safety gate for the live workspace: validated/atomic snapshots, retention that
   survives rapid dev restarts, and one rehearsed restore path.
3. Add a concrete Rust `WorkspaceService` + direct Link
   creation → MCP read-Board/batch-add-Links vertical slice → cross-process refresh
   and durable batch undo.
4. Browser-like board tabs + Quick Boards, then clipboard copy of images.
5. Filesystem shortcuts after the external addressing/access model is proven; do
   not add a speculative card kind to the schema now.
