# Lessons

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
