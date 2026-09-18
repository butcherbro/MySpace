# Lessons

## 2026-09-18 — Asset natural size is never persisted; the frontend must read it

- Root cause found while fixing image cards cropping under a mismatched frame:
  `assets.width`/`height` columns exist in the DB (`src-tauri/migrations/0002_assets.sql`)
  and the `AssetDto` type carries them, but `import_asset` in
  `src-tauri/src/domain/asset_service.rs` never populates them — every import
  writes `NULL`. Any frontend code that assumes `asset.width`/`height` are
  usable is wrong today; only a browser-side `Image()`/`<img>.naturalWidth`
  read is reliable (see `src/cards/image/image-card-geometry.ts`).
- Consequence: don't add an `image` crate / backend dimension read for this
  unless a second consumer needs it server-side (e.g. thumbnail generation
  without a renderer) — YAGNI for a single UI-only need. If a future feature
  needs natural size before the asset is even displayed (no `<img>` mounted
  yet), that is the trigger to finally wire real width/height into
  `import_asset`.

## 2026-09-09 — External-agent handoff is a routing decision

- User correction: when the user asks to hand work to an external agent in
  another IDE, stop doing the implementation in the current session and create
  an exact pickup packet instead of silently continuing with internal agents.
- Consequence: anchor detached commits on a named branch, preserve intentional
  WIP without committing a RED block, record commands/results/root causes in
  `.continue-here.md`, and give the user one copy-paste prompt for the external
  agent.

## 2026-09-10 — Window dragging needs the Tauri permission, not CSS

- User-reported failure: after a refactor the window could not be dragged (only
  resized) and a mousedown on the title bar painted a marquee on the canvas.
- Root cause: WKWebView does not honor CSS `-webkit-app-region`, and even the
  official `data-tauri-drag-region` attribute conflicts with full-width
  interactive chrome. The explicit `getCurrentWindow().startDragging()` path
  also fails silently unless `core:window:allow-start-dragging` is granted in
  `src-tauri/capabilities/default.json` (the `core:default` set only has read
  window commands).
- Consequence: call `startDragging()` on title-bar mousedown (skipping
  `button/input/a/[data-no-drag]`), and keep the capability granted. Verify
  drag in the packaged `.app`, never just in `tauri dev`.
- Related UX: Quick Boards starts collapsed; a collapsed icon strip hides its
  scrollbar so it never overlaps the pinned icons.

## 2026-08-28 — Note pointer intent

- User correction: a normal click on a Note must edit immediately. Holding the same click and moving must drag either a Note or Board Portal.
- Implementation consequence: distinguish click from drag with a movement threshold instead of requiring double click or a permanent drag handle.
- While a Note is already editing, text gestures select text and the outer frame remains the move surface.

## 2026-09-01 — Product north star and future agent surface

- User correction: the product is primarily a personal visual filesystem inspired by Milanote, not a conventional note editor with a canvas added on top.
- V1 must prioritize spatial recognition, free placement, and Boards inside Boards; visual fidelity and the direct-manipulation interaction model are product requirements, not optional polish.
- Future filesystem shortcuts should visually project linked Mac folders and their contents without copying the underlying files into the workspace.
- A future in-app agent chat may accept text, links, and images, then create, place, group, or reorganize workspace information through the same typed domain commands used by the UI.
- The agent provider is intentionally undecided (a terminal agent or Hermes-like installation are candidates). Provider-specific APIs must not enter the V1 board/card domain model.
- This agent surface is a future control plane over the visual workspace, not part of V1 and not the product's primary navigation model.

## 2026-09-05 — The agent surface is the product's core value

- User clarification (extends and strengthens the north-star): the key value of MySpace is
  **flexible interaction with any agent that has access to the MySpace store** — to easily
  add things to a Board or read information back out.
- Consequence: agents must interact through a **stable storage interface** (typed workspace
  commands), not through fragile references to the internal physical layout (`assets/<uuid>`,
  per-board folders). A per-asset file path exists, but a "board path" as a folder does not.
- The agent contract is therefore a first-class control plane (read/add/move cards, notes,
  links, images, boards), not an afterthought export path. Provider-specific APIs stay out of
  the board/card domain model; any agent is a client of the same command layer as the UI.
- Do not couple the agent surface to a single provider (terminal, Hermes, etc.); the surface
  must remain provider-agnostic so "any agent with access" is a supported client.

## 2026-09-05 — Backups protect live working data during development

- User clarification: backups are needed now because the normal workspace database is already being filled with real Boards, Notes, images, and links while migrations and command contracts are still changing.
- Consequence: a startup copy is not merely V1.1 polish. Before further risky migrations or any external agent write surface, MySpace needs validated snapshots, retention that cannot be exhausted by rapid dev restarts, and a tested restore path that a non-developer can execute without manually manipulating WAL/SHM files.

## 2026-09-01 — ID generation stays on the frontend

- Decision (review follow-up): keep card/board IDs as an input to `create_*` commands rather than returning backend-generated IDs.
- Rationale: the plan requires stable IDs before persistence; optimistic UI needs them upfront; a lost backend response can be safely replayed with the same ID; Board + Portal creation needs both IDs known in advance.
- Therefore replace native `crypto.randomUUID()` (UUIDv4) with a centralized frontend `IdGenerator` producing UUIDv7, injectable and deterministic in tests.
- Backend must still validate UUID shape and reject conflicting reuse of an existing ID.

## 2026-09-04 — Spatial chrome and extensible tool rail

- User correction: creation actions do not belong in the top toolbar. Note, Link, Board, and Image creation live in a narrow Milanote-like left rail.
- User correction: the standalone top-bar Home button is redundant. The Home breadcrumb is always clickable and is the sole return path to the root workspace Board.
- The top bar is navigation-only: breadcrumbs first, a future browser-bookmark-like Quick Boards region after them, then mandatory Search and workspace Undo/Redo.
- The left rail is contextual. Hovering or selecting a Note can replace creation tools with Note tools such as background color and text color.
- Hover-driven context needs an intent delay and a card-to-rail grace period; pure CSS hover would make the tools disappear while the pointer crosses to the rail.
- Tags and Quick Boards are future extensions. Reserve clean component/data boundaries now, but do not show non-functional controls.
- Production icons must use one coherent outline family rather than emoji or mixed glyph styles.

## 2026-09-04 — Link previews are a one-time card conversion

- User clarification: one HTTP(S) URL with no other semantic content becomes a visual Link Card at Enter or blur; surrounding whitespace and empty lines do not prevent conversion.
- Mixed text plus a URL, or two or more URLs, remains a Note with clickable inline links.
- After conversion, editable title/description do not cause automatic conversion back to Note. Preview state is explicit, not continuously inferred from `documentJson`.
- Link preview images and Board Portal covers must support replacement from the macOS clipboard through explicit contextual actions.
- Explicit target commands own replacement. Selecting a card alone must not redirect all canvas paste operations to its cover.
- User clarification: after one-time URL conversion, a Link Card never changes kind merely because body content is added. Its lower body may grow like a rich-text Note while retaining its preview identity.
- Minimum visible text formatting is Bold through the contextual rail and `Command-B`. Text color, marker/highlight color, and whole-Note background color are separate later capabilities with separate data semantics.
- Existing backend terminology wins: the user-facing Link Card maps to the existing `embed` card kind, `embed_cards` table, and `EmbedCardDto`. Do not introduce a competing `link` kind or `link_cards` table.
- 2026-09-04: React Flow `defaultViewport` resets only on first mount. If a board must reopen at `(0,0)`, carry an explicit board-open token and call `setViewport(...)` on reopen; store-only resets are invisible to the actual canvas.
- 2026-09-04: Note autosave and semantic card conversion are different contracts. Debounced saves may persist draft content, but URL-only Note -> Link conversion must stay behind explicit finalize events (`Enter`/`blur`) or the editor will mutate state while the user is still typing.

## 2026-09-04 — Verify the live build before visual QA

- User correction: activating a macOS app by product name is not proof that the visible window represents the current source revision.
- Before using a live window as evidence, verify its PID, working directory, dev-server, branch/worktree, and a visible feature or build marker from the current code.
- If the window is visually missing features that exist in source, treat the runtime as stale or mismatched and discard the observation until a controlled fresh launch confirms it.
- User correction: an isolated diagnostic bundle looks like data loss when it opens under the same product name. Before launching one, state visibly that it uses a separate empty database; prefer a distinct window title and restore the normal bundle immediately after collecting evidence.
- User correction: do not leave a live Tauri window on a frontend HMR revision that calls a backend command which is not registered yet. Stop the dev app during cross-boundary implementation and relaunch only after the Rust command and frontend contract pass together.

## 2026-09-05 — Link Cards fit enriched content

- User correction: a Link Card must reveal its preview image, title, and description immediately after metadata arrives; retaining the short source Note height and requiring a manual downward resize is not acceptable.
- Implementation consequence: enriched Link Cards own a content-driven minimum height. They may grow and persist that frame automatically, while an already larger user-sized frame is never shrunk.

## 2026-09-05 — Breadcrumbs are navigation and organization targets

- User correction: the Board path is always root-first (`Home / … / Current Board`); Home is never the tail of the path and every Board name in the path must navigate to that Board.
- User correction: Board Portals behave like Finder folders. Moving a portal onto another portal reparents the underlying Board, and dropping it on any breadcrumb ancestor moves it up the hierarchy without copying it.
- Implementation consequence: deep paths must expose every ancestor during drag, even if middle crumbs are normally collapsed. Board moves require an atomic parent-plus-portal transaction and cycle protection; widening the leaf-card move query would corrupt the hierarchy invariant.

## 2026-09-06 — The application command layer exclusively owns deletion

- User-reported failure: a Note or Board could disappear after deletion and then return when the Board projection was loaded again.
- Root cause: plain `Backspace`/`Delete` could not reach the durable Trash command because the application handler returned unless Cmd/Ctrl was pressed, while React Flow still retained its independent built-in deletion path.
- Implementation consequence: disable React Flow's `deleteKeyCode` and route both plain keyboard deletion and context-menu deletion through `TrashSelectionCommand`. A canvas library may report selection and gestures, but it must never own persistence-visible removal.
- Regression requirement: delete a mixed Note plus Board Portal selection, trigger a later projection rebuild, and prove the removed objects do not return.

## 2026-09-06 — The Desk grid is an orientation tool, not decorative noise

- User correction: the Milanote-like dot grid must remain clearly visible; making it "quiet" until it disappears breaks spatial orientation.
- Reference calibration after live-size correction: `#ebedee` Desk, `#dfe1e2` dots, `20px` gap, and React Flow `size={3}` at zoom 1. The grid scales naturally with canvas zoom.
- Implementation consequence: keep the grid parameters under a regression test and validate at reduced zoom and on Retina rather than judging only from token opacity.

## 2026-09-07 — Treat live-only visual degradation as a stateful regression

- User correction: the Unsorted rail rendered correctly at first and degraded only after an interaction in the running Tauri app.
- Root cause of the gray strip: removing the last Unsorted card removed explicit grid column 3, while Quick Boards stayed assigned to column 4. CSS Grid created an empty implicit column between the canvas and Quick Boards.
- Root cause of the blue overlay: React Flow 12 does not clear its marquee rectangle on `pointercancel`; Escape and window blur also leave it active. WKWebView makes lost final pointer events easier to encounter.
- Investigation consequence: do not lead with WKWebView feature support when a UI worked earlier in the same runtime. Reproduce the exact state transition and assert geometry after conditional layout regions disappear.

## 2026-09-07 — Unsorted placement is one atomic state transition

- User-reported failure: dragging a card from Unsorted removed it from the rail, but it stayed invisible until the Board was reopened; later edits intermittently raised `stale_revision`.
- Root cause: `cardReplaced` searched only the visible `cards` collection, so it could not update an object still held in `unsortedCards`. The following action then appended that old object with its pre-placement frame and revision.
- Implementation consequence: moving Unsorted -> canvas must atomically remove the source object and append it with the exact persisted frame and incremented revision. Never compose a cross-collection transition from an update action that cannot address the source collection.

## 2026-09-07 — Visible Redo requires commands to survive repeated execution

- A reactive Redo button exposed an older hidden contract bug: move commands reused their initial optimistic revision after Undo, and create commands attempted a duplicate insert instead of restoring their soft-deleted entity.
- Every move command now advances its owned expected revisions only after each successful direction. Create commands retain the Trash batch returned by Undo and restore that batch on Redo.
- The dispatcher must peek before an asynchronous Undo/Redo and move the command between stacks only after success; otherwise a failed durable mutation silently destroys history.

## 2026-09-08 — Group move snapshots, not live cards; and refresh revisions before batch commit

- Cross-board drag must carry a snapshot of every dragged card captured at drag
  start. After the target board opens, the live `state.cards` projection already
  points at the target board, so resolving the group from `cardsRef` at commit
  time finds nothing and silently drops the group.
- Consequence: the drag state machine owns `cards` (full snapshots: id/kind/revision/
  boardId/frame + board-portal target info), and `ghostCard` is just `cards[0]` for
  rendering.
- A leaf batch move must refresh each card's revision via `readCard` immediately
  before `move_cards_to_board_unsorted`; a draft save on blur can bump revisions after
  drag start and otherwise reject the whole batch as stale.
- `elementFromPoint` on a dropped board portal resolves the dragged node itself
  (it follows the cursor), so portal drops must be resolved in the canvas by frame
  overlap (`portalAtPoint`), not by `data-board-drop-id` hit-testing.
  - 2026-09-18 addendum (todo.md №22): pure frame-overlap picked whichever
    portal the dragged card's edge covered *most*, so a big card dragged toward
    portal A could still resolve onto neighbouring portal B whenever B's edge
    happened to catch a larger fraction of the card's own rectangle — even with
    the pointer sitting squarely over A. `portalAtPoint` (`src/canvas/CanvasAdapter.tsx`)
    now checks the release-time cursor position (board-space, via
    `screenToFlowPosition`) against each portal's frame FIRST, and only falls
    back to frame-overlap when the cursor itself is not over any portal. The
    hover highlight (`onNodeDrag`) uses the same resolution so it never shows a
    portal the drop will not actually land on.
- `set_note_color` must NOT bump the card revision: color is orthogonal to text, and
  bumping it races the text autosave's `expected_revision` on the same card.

## 2026-09-18 — `cardsRef` is only eventually-consistent across chained queue tasks

- New contract discovered while fixing note auto-grow (backlog problem 2): `App.tsx`
  keeps `cardsRef.current` in sync with `state.cards` via a plain `useEffect`
  (`src/App.tsx:128`). That effect runs on React's next commit — a macrotask-ish
  scheduler tick — but `MutationQueue.run()` (`src/persistence/entity-write-queue.ts`)
  chains queued tasks with plain `Promise.then`, which resolves as a *microtask*.
  Two mutations enqueued back-to-back on the same card (e.g. a content autosave and
  a resize, both debounced off the same keystroke) can therefore have the second
  task read a stale `revision` from `cardsRef.current` before the effect from the
  first task's dispatch has run — the backend then rejects it as `stale_revision`,
  even though the two writes were correctly serialized by the queue.
- Consequence: any queued mutation callback that dispatches a revision-bumping
  action must also patch `cardsRef.current` synchronously, right next to the
  `dispatch(...)` call, mirroring exactly what the reducer does for that action
  (see `src/App.tsx` — `handleUpdateNote`, `handleFinalizeNote`,
  `handleResizeNote`, and the pre-existing `requestEmbedMetadata` for the
  original instance of this pattern). Relying on the `useEffect` sync alone is
  only safe for a *single* isolated mutation, never for two that can queue in
  the same tick.
- This is the same family of bug as the 2026-09-08 group-move revision race
  above, but on the "two of the app's own debounced autosaves collide" axis
  rather than "a drag snapshot outlives its window" axis — worth checking
  whenever a new debounced write is added next to an existing one on the same
  card (e.g. future image/caption auto-fit).

## 2026-09-09 — Filesystem shortcuts must read as folders and reveal names

- User preference: a folder shortcut should keep a large, unmistakable blue
  folder silhouette while showing a Finder-like list of real child names inside
  that silhouette. Thumbnail-only mosaics do not provide enough information.
- Design consequence: use the folder surface as a bounded live-content window
  with file-type icons, names, and compact metadata; preserve the silhouette at
  every resized height and collapse overflow behind an item count.
- User-approved V1 scope: the folder shortcut is resizable from the bottom-right
  corner, but only the direct Finder link and shallow live preview ship first.
  In-card navigation/expansion and copied File Cards remain later slices.

## 2026-09-18 — readCard-before-move narrows the draft-flush race, it does not close it

- The 2026-09-08 fix (refresh each leaf's revision via `readCard` right before
  `move_cards_to_board_unsorted` / `move_selection_to_board`) leaves a second,
  smaller window open: the blur-triggered draft flush (`update_note`) can still
  land *between* that `readCard` response and the move's own IPC round-trip.
  The bigger the note, the slower the flush write, the wider that window — this
  is why the drop-onto-a-board-portal bug was reported as "mostly with large
  multiline notes". The backend correctly refuses the whole atomic move on the
  stale expectation (ADR-0007); the frontend just had no retry, so a genuine
  race looked to the user like the card had vanished (it stayed on the source
  board with only an error banner, never reaching the target's Unsorted panel).
- Fix: `src/canvas/move-selection-onto-board.ts` centralizes the
  readCard-refresh + `MoveSelectionCommand` call for both cross-board drop
  paths (on-canvas portal drop in `src/App.tsx`'s `handleCardsDroppedOnBoard`,
  and the breadcrumb/tab cross-board drag in `handleCardDragEnd`) and retries
  once, re-reading revisions again, on a `stale_revision` refusal. Two call
  sites had copy-pasted the same vulnerable pattern; one shared helper closes
  the race in both instead of just one.
- Also fixed in `src/services/error-message.ts`: a serde tuple-content
  `WorkspaceError` variant (e.g. `StaleRevision { expected, actual }`)
  serializes as `{ code, message: {expected, actual} }` — `message` is an
  OBJECT, not a string, so the old code fell through to the bare `code`
  ("stale_revision" with no numbers). This made the one error a user might
  have seen during the race completely uninformative.
- Lesson: a documented single-attempt "refresh the revision right before
  sending" is a mitigation, not a fix, for a race against an independent async
  write triggered by the same gesture (blur flush on drag start). Any
  read-then-write-elsewhere-then-write pattern like this needs either a retry
  bounded by the specific error it's guarding against, or the write it's
  racing against must itself be awaited before the read.

## 2026-09-18 — An unbounded external-process call is a product hang, not just a flaky test

- `asset_service::stage_thumbnail` (`src-tauri/src/domain/asset_service.rs:412`)
  shelled out to macOS `qlmanage -t` via `Command::status()` with no timeout,
  to render a Quick Look thumbnail during file-card import. `qlmanage` parks
  its main thread in an `NSRunLoop` and never returns when it has no
  WindowServer session (headless shell, sandboxed test run, some CI/agent
  environments) — confirmed with `sample <pid>` on the hung process. Test
  `asset_service.rs::a_failed_thumbnail_leaves_no_orphan_and_still_creates_the_card`
  hit this by calling `stage_thumbnail` against a nonexistent path.
- This was not a test-only artifact: `stage_thumbnail` is called from the live
  import path (`src-tauri/src/commands/filesystem_aliases.rs:281`), so the same
  hang could freeze a real file-card import inside the shipped app, on any
  machine/session where `qlmanage` can't reach WindowServer.
- Fix: `run_qlmanage_bounded` spawns the child with `Command::spawn()` and polls
  `try_wait()` against a 5s deadline, `kill()`-ing the child on timeout, instead
  of blocking on `.status()`. No new dependency (no tokio in this crate) —
  a `spawn` + poll loop is enough for a single bounded external call.
- Lesson: any `Command::status()`/`.output()` call to an external OS tool from
  request-handling code is an unbounded wait by default. If the tool can ever
  hang (missing display session, missing daemon, waiting on a dialog), that
  hang reaches the caller — test or production — exactly the same way. Treat
  every shell-out as needing an explicit timeout unless the tool's own
  contract guarantees bounded execution.
- Also: killing a parent process (Ctrl-C, a broken `timeout` wrapper, a test
  harness deadline) does not kill an orphaned grandchild it spawned via
  `Command` — those reparent to pid 1 and keep running. Stray `qlmanage`
  processes from earlier failed runs were still alive 30+ minutes later at
  0% CPU; always check `ps` for leftover children by name, not just the PID
  you started, when a "timeout" didn't actually stop the process tree.

## 2026-09-18 — An undoable move must go through the dispatcher, not the gateway directly

- User-reported failure: dragging a large note onto another board's portal
  worked (card correctly landed in the target's Unsorted panel), but `Cmd+Z`
  right after did nothing visible and raised a `stale_revision` toast with
  equal expected/actual numbers.
- Both hypotheses in the bug report were plausible but wrong: the TS error
  renderer (`src/services/error-message.ts`) already correctly unpacks
  `{ expected, actual }` and was already covered by a test with distinct
  values — not the bug. And `MoveSelectionCommand.undo` does use the
  receipt's real `afterRevision`, not a stale pre-retry value — also not
  the bug for the path actually hit.
- Real root cause: the single-card "drop onto a board portal" handler
  (`handleCardDroppedOnPortal`'s leaf branch, `src/App.tsx`) called
  `gateway.moveCardsToBoardUnsorted(...)` directly instead of going through
  `CommandDispatcher.execute(...)`. The sibling group-drop handler
  (`handleCardsDroppedOnBoard`) and the board-portal branch of the same
  handler both dispatch commands correctly — only this one leaf-card path
  was wired straight to the gateway, so the move never entered undo history.
  `Cmd+Z` then undid whichever older command was still on top of the stack,
  which had since gone stale — hence an unrelated `stale_revision` toast and
  no visible change.
- Fix: the leaf branch now calls `moveSelectionOntoBoard` (the same
  dispatcher-integrated helper the group path already used), for a
  single-leaf selection with no portals.
- Secondary, masking bug found and fixed along the way:
  `undo_move_selection` (`src-tauri/src/domain/move_selection.rs`) echoed
  `after_revision` back as both `expected` and `actual` on a stale-revision
  refusal, instead of reading the row's real current revision (the pattern
  `update_note` already uses). This made every undo stale-revision toast for
  the mixed-selection path uninformative — equal numbers regardless of what
  actually raced it — and is why the reported numbers looked identical.
- Lesson: any user-facing action that has an "undo" affordance (Cmd+Z, an
  Undo button) must be verified end-to-end through the exact code path the
  UI wires it to, not just at the level of the reusable helper function. A
  helper being correct and well-tested (`moveSelectionOntoBoard` already
  was) does not mean every call site actually uses it — grep every call site
  of the raw gateway method the helper wraps before trusting "it's tested."
  Also: when a bare `WorkspaceError::StaleRevision` refusal is constructed
  from a failed conditional `UPDATE ... WHERE id=? AND revision=?`, the
  `actual` field must be a fresh `SELECT`, never a copy of `expected` — a
  copy is silently indistinguishable from "nothing is wrong" in the message.

## 2026-09-18 — A drag preview needs one size, owned by the same state, everywhere it's drawn

- User-reported failure: dragging a resize handle on an image or note card
  inward shrank the content immediately, but a "ghost" border at the old size
  stayed visible around it until the pointer was released, then snapped to
  match.
- Root cause: `.canvas-card-frame` (`src/canvas/CanvasAdapter.tsx`), the
  element that paints the selection border, was forced to `width: 100%;
  height: 100%` of its React Flow node — and the node's own box comes from
  `card.frame.width/height`, the *persisted* frame, which only changes when
  the resize commits on pointer-up. Every resizable card (note, image, embed,
  file, folder shortcut) already tracks its own live drag size on its own
  root via an inline `style={{ width, height }}` sourced from local draft
  state — so during a drag there were two competing sizes for the same
  visual object: the content's live one and the frame's stale one.
- Fix: stopped forcing the frame's size at all — `width/height: fit-content`
  in CSS, and dropped the inline `style={{ width: "100%", height: "100%" }}`
  React was adding on top of it. The frame now has no size of its own; it
  takes it entirely from its child, so it can never go stale relative to the
  content it wraps. The underlying React Flow node's own box stays stale
  during a drag exactly as before (it still only updates on commit), but
  that's invisible now — canvas.css already makes `.react-flow__node` itself
  paint nothing (`background: transparent; border: 0; box-shadow: none`), so
  its lagging size no longer matters visually.
- Lesson: when several DOM layers represent "the same thing" during an
  interactive drag (a resize, a drag-reorder, anything with a committed vs.
  live state), a fixed/percentage size on an outer wrapper is a second,
  independent source of truth for that thing's size. It will silently
  disagree with whatever inner element tracks the live value, and the
  disagreement is invisible until you actually watch the drag frame-by-frame
  — a before/after screenshot comparison (pointer down vs. pointer up) can't
  catch it, because both endpoints already match; only the state *during*
  the drag is wrong. Prefer wrappers that size themselves from their content
  (`fit-content`, or no explicit size at all) over wrappers that duplicate a
  size from persisted state, whenever the content can change size on its own.

## 2026-09-18 — `onPaneDoubleClick` changed contract: emits flow point + screen point

- Task: `tasks/todo.md` №10 — double-click and right-click on the empty canvas
  now open a compact create menu ("Add Note" / "Add Board") at the cursor,
  instead of double-click creating a note directly.
- Contract change: `CanvasEvents.onPaneDoubleClick` (`src/canvas/canvas-types.ts`)
  used to hand the caller only the board-space point (for creating a card
  there). Placing a *menu* needs the screen-space point too — CSS `position:
  fixed` menus are laid out in client coordinates, not board coordinates, and
  those only coincide at zoom 1 / pan (0,0). Rather than have the caller
  reverse-derive screen coordinates from a board point (there is no
  `flowToScreenPosition` plumbed through the adapter, and adding one just to
  invert a conversion the adapter had already done once is circular), the
  adapter now emits both: `onPaneDoubleClick(point, screen)`. Same reasoning
  applies to any future canvas event that positions a screen-space overlay
  from a pointer gesture — pass both spaces the first time, since the flow
  point can be recovered from raw state but the screen point cannot be
  recovered downstream without another conversion path.
- Also folded "Add Note"/"Add Board" into the existing pane `ContextMenu`
  (right-click) rather than building a separate menu component, and added
  Esc-to-close to `ContextMenu` itself (it only closed on backdrop click
  before) — a generic fix that now benefits every context menu in the app,
  not a special case for this one.

## 2026-09-18 — Neither hypothesis in №13's brief matched the code

- Task: `tasks/todo.md` №13 — paste formatted text (Telegram/browser) with
  formatting preserved, both into an open note editor and onto the empty
  canvas (creating a new note).
- The brief's premises did not hold, checked by `grep -rn "paste\|clipboardData"
  src/` before writing anything:
  - Path (a), paste into an open editor: the brief worried about "a custom
    paste handler intercepting clipboard as text/plain" or "a global canvas
    paste handler running first". Neither exists — `src/editor/NoteEditor.tsx`
    is a bare Tiptap `useEditor()` with no `editorProps.handlePaste` and no
    `onPaste` prop; nothing in the app attaches a `paste` listener above it.
    ProseMirror's own default paste handling already runs, and it already
    parses `text/html` against the editor's schema. `src/editor/NoteEditor.test.tsx`
    now has two tests proving this with a real `fireEvent.paste` + synthetic
    `clipboardData` — no production code changed for this path.
  - Path (b), paste onto the empty canvas: the brief assumed a create-note-
    from-`text/plain` path "as is" existed and just needed a `text/html`
    branch added. There was no canvas-paste-to-create-card feature at all —
    `grep -rn "ClipboardEvent\|clipboardData"` across all of `src/` returned
    zero matches outside `services/clipboard.ts` (write-only) and the two
    editor files above. Built it from scratch: `src/app/use-canvas-paste.ts`
    (a global `paste` listener that backs off when the target is inside any
    text-entry control, so it never competes with (a)) plus
    `src/editor/html-to-document.ts` (`generateJSON` through the editor's own
    `createEditorExtensions()`, so the same schema filters both paths
    identically) wired into `App.tsx`'s existing `handleCreateNote`.
- Why inline color/font never leaks in either path: the editor's marks
  (Bold/Italic/Strike) declare no `attrs` at all, and the one mark that does
  (`TextColor`, `src/editor/text-color.ts`) only matches `span[data-color]` —
  never a bare `style="color:…"`. Tiptap's *default* Bold/Italic *do* read
  `font-weight`/`font-style` inline styles to decide whether to apply the
  mark (useful — it's how Telegram's `<span style="font-weight:600">` copy
  becomes real bold), but that only ever produces the mark itself, never
  stores the style value anywhere in the document. No sanitizer needed
  beyond "use the same restricted schema everywhere paste can reach it."
- Lesson: a task brief's root-cause guess is a hypothesis, not a fact, even
  when it's phrased as "выясни, почему" — the grep it invites you to run can
  (and here did, twice) come back empty. Do that grep before opening any file
  to fix, and say plainly in the report that both guesses were wrong instead
  of quietly building around them.

## 2026-09-18 — Card copy/paste (№15): in-memory clipboard chosen over a custom system-clipboard mime

- New contract: `src/app/card-clipboard.ts` is a module-level (not React
  state) buffer for `Cmd+C`/`Cmd+V` of notes/images. Considered writing a
  custom mime (`web application/x-myspace-cards+json`) via
  `navigator.clipboard.write`/`ClipboardItem` instead — rejected because
  `ClipboardItem` only accepts a browser-approved type whitelist
  (`text/plain`, `text/html`, image formats); WKWebView enforces the same
  restriction, so a custom mime throws rather than round-tripping. The
  in-memory buffer is therefore the only reliable V1 answer, at the cost of
  same-window-only paste (acceptable per the brief). `use-canvas-paste.ts`'s
  `handlePaste` checks it first (`onPasteCards`), before text/html — it wins
  unconditionally whenever non-empty, since it's the only way to interpret a
  paste as ours vs. some earlier system-clipboard content.
- `image_cards.asset_id` GC (`src-tauri/src/domain/asset_service.rs`,
  `collect_orphaned_assets`) already does `NOT EXISTS (SELECT 1 FROM
  image_cards i WHERE i.asset_id = a.id)` — i.e. it counts *any* row, not a
  specific card — so several image cards already safely share one asset_id
  with no backend change needed for the copy-in paste model.
- Pure placement math (`buildPasteSpecs` in `card-clipboard.ts`: cursor +
  each card's `dx`/`dy` offset from the copied group's top-left) was
  extracted out of `App.tsx` specifically so it has its own unit tests —
  `App.tsx` itself has no test harness (no `App.test.tsx` exists in this
  repo), so anything that needs isolated coverage has to be pulled into its
  own module before it's wired in, not tested by proxy through the giant
  component.
- One dispatcher entry per pasted group: `PasteCardsCommand`
  (`src/commands/paste-commands.ts`) creates every card in `execute`, then
  trashes them all as a single batch in `undo` (reusing the existing
  `trashSelection`/`restoreTrashBatch` batch primitive) — never delegates to
  per-card sub-commands' own undo, which would have produced N separate Trash
  batches instead of one Cmd+Z.

## 2026-09-18 — Duplicate board (№16): descendant ids must come from the
backend, and undo needed no new receipt at all

- Task: `tasks/todo.md` №16 — duplicate a Board Portal's whole subtree
  (recursively, including nested Board Portals) via copy/paste and a
  "Duplicate" context-menu action.
- Contract exception, written up as ADR-0009: every other write command in
  this codebase takes 100% frontend-generated ids (`current-state.md`'s own
  settled rule). Duplicate cannot — the frontend has no visibility into what a
  board contains before the copy runs (it might be several nested boards
  deep), so only the root board id and root portal card id are
  frontend-generated; every copied descendant's id is generated by the
  backend inside the one transaction that discovers it needs copying. Do not
  try to preserve "frontend generates every id" here by having the frontend
  pre-fetch the whole subtree first — that duplicates the transaction's own
  read work with no atomicity between the read and the write.
- Undo needed **no new receipt type at all**, unlike ADR-0007's mixed-selection
  move. The new board is a completely ordinary board with a completely
  ordinary portal card, so the existing `trash_board`/`trashSelection` cascade
  (which already walks a board's full subtree by `parent_board_id`) undoes the
  whole duplicate by trashing just the one new `board_id` — restore brings all
  of it back by the same batch id. Before reaching for a new receipt-and-undo
  pair (the reflex after ADR-0007), check first whether the operation's output
  is indistinguishable, from Trash's point of view, from anything a user could
  have created by hand — if so, the existing cascade is the undo, and building
  a parallel one is pure duplication.
- `trashSelection`'s existing convention — a `"board_portal"` item's `id` is
  the *board* id, not the portal card id (confirmed by reading
  `handleDeleteSelection`'s existing mapping before writing any new code) —
  is exactly the right shape for a copied board's undo contribution too: no
  new trash-item kind was needed, just reusing the established id convention
  from a completely unrelated call site.
- GC needed zero changes. `asset_service::collect_orphaned_assets` already
  counts an asset's owners with `NOT EXISTS` across every owning table
  (`image_cards`, `embed_cards.asset_id`/`favicon_asset_id`,
  `boards.cover_asset_id`, `file_cards.asset_id`/`preview_asset_id`) — it was
  never a per-card cap, so a duplicate sharing an original's `asset_id` is
  automatically safe. Always check whether a "copy-in" concern like this is
  already handled generically before writing a special case for it.

## 2026-09-18 — Server-side cascades need a client-side patch for what's on screen right now

- Task: `tasks/todo.md` №17 — board shortcuts. Trashing a Board Portal now
  cascades server-side to every shortcut pointing at it or a descendant board
  (same trash batch, so restore brings both back for free — see
  `docs/decisions/0010-board-shortcuts.md`).
- Non-obvious gap this created: `handleContextDelete`/`handleDeleteSelection`
  in `App.tsx` update local state optimistically with `dispatch({ type:
  "cardsRemoved", ids })`, where `ids` is only the card(s) the user actually
  selected/right-clicked. The backend's cascade silently removed additional
  rows (a shortcut sitting on the SAME currently-open board) that the
  frontend's optimistic patch never knew to remove — it stayed rendered as a
  ghost until the next full snapshot reload. An e2e test caught this
  immediately (`tests/e2e/board-shortcuts.spec.ts`): portal count went to 0,
  shortcut count stayed at 1.
- Fix: compute the extra locally-visible cascade victims (shortcuts in
  `state.cards` whose `target.id` is one of the boards being trashed) and fold
  their ids into the same `cardsRemoved` dispatch — but do **not** add them to
  the `TrashSelectionCommand`'s own `items` list sent to the backend, since
  the backend already trashed them in the same transaction; re-sending an
  already-trashed leaf as its own trash item hits `NotFound` and fails the
  whole atomic call.
- Scope of the fix is deliberately partial: it only patches cards visible on
  the currently-open board. A shortcut on a *different* board pointing deeper
  into the trashed subtree is not locally patched — it self-heals the moment
  that other board is opened, because `loadBoardSnapshot` always reflects the
  backend's authoritative cascade. Restore already reloads the whole board via
  `useTrashController.restoreBatch`'s `reloadBoardRef.current?.()`, so nothing
  extra was needed on that side.
- Lesson: any time a backend command's effect radius is wider than the ids the
  frontend explicitly sent it (a cascade, a batch trash, a recursive delete),
  audit every place that does an optimistic *local* patch keyed on "the ids I
  sent" — a cascade is definitionally "ids I didn't send." Write the e2e test
  for the cascade case (not just the direct case) before declaring the slice
  done; a unit test of the backend cascade alone would have missed this
  entirely, since the bug was purely in the frontend's optimistic patch.
