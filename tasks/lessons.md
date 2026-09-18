# Lessons

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
