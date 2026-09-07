# Search Specification

## Status

Draft for agreement. This document is the product and interaction source of truth for the
mandatory V1 Search palette. It extends Task 11 of
`docs/plans/2026-09-04-spatial-workspace-interface.md`. The three scope decisions marked
**Open** below are intentionally NOT guessed; they must be agreed before schema/index work
starts.

## Product intent

The user already keeps real material on Home and nested Boards. Search is the primary way
to relocate that material without walking the breadcrumb tree. It must answer "where is
that note / link / board?" and take the user to it in one action. It is a palette, not a
permanent sidebar (see the locked visual decisions).

## Scope of indexed content (fixed)

V1 indexes exactly these fields, nothing more:

| Entity | Indexed fields |
|---|---|
| Note | authoritative `plain_text` |
| Link Card (`embed`) | `title`, `source_url` (and `display_url`), `description_plain_text` |
| Board | `title` |

Explicitly out of scope for V1: image captions and image filenames, Board Portal tiles,
asset file contents, full-text over `document_json` beyond the derived `plain_text`,
tags, and any external filesystem content.

Trashed entities (non-null `deleted_at`) are never returned.

## Result contract (application-level, not raw SQLite rows)

```ts
interface SearchResult {
  entityId: string;
  kind: "board" | "note" | "link";
  title: string;
  excerpt: string | null;
  boardId: string;
  boardTrail: Array<{ id: string; title: string }>;
}
```

- `kind` is the user-facing kind. A Link Card (`embed`) is reported as `"link"`.
- `title` is the primary display line: Note `plain_text` excerpt, Link `title` (fallback
  `source_url`), Board `title`.
- `excerpt` is a bounded match-context snippet; `null` when the match is the title itself.
- `boardId` is the board that contains the entity (for Boards, `boardId === entityId`).
- `boardTrail` is `Home / … / boardId` so a result can be shown with its location even if
  the search is not board-scoped.

## Query behavior (fixed)

- Case-insensitive substring match using indexed/escaped `LIKE` over the authoritative
  derived `plain_text`, Link `title`/`source_url`/`description_plain_text`, and Board
  `title`.
- Empty query returns nothing (do not dump the whole workspace).
- Results are bounded (V1 limit 50).
- Stable ordering (see **Open — ranking** below; until agreed, the only fixed rule is
  deterministic tie-breaking by `entityId`).

No FTS until measurements show `LIKE` is insufficient at real scale.

## Result activation (fixed)

On selecting a **Note** or **Link** result:

1. Load the entity's Board snapshot.
2. Center the viewport on the card.
3. Select the card.
4. Apply a transient focus pulse.
5. Leave edit mode off until the user clicks the Note.

On selecting a **Board** result: navigate to that Board's last-saved viewport (opening a
board tab like breadcrumb navigation).

## Palette interaction (fixed)

- `Command-K` opens the palette; focus lands in the query input.
- 150 ms debounce before querying.
- Keyboard navigation (up/down/enter) and `Escape` to close.
- Grouped presentation with the `boardTrail` shown per result.
- `560px` surface below the top bar, clamped to the window, canvas visible behind a light
  non-blocking scrim. No permanent search sidebar.

## Open questions (must agree before implementation)

1. **Scope — global or current board?**
   - Global: search all Boards in the workspace.
   - Current board: search only the open Board.
   - Hybrid (e.g. current board first, then a "Search all boards" affordance) is possible
     but must be decided, not assumed.
2. **Ranking rules.**
   - Options include: title/prefix match first, then body match; recency (most-recently
     updated first); alphabetical; or a small weighted score. Until decided, only
     deterministic tie-breaking by `entityId` is fixed.
3. **Visual highlight of the found card.**
   - Whether to flash, outline, or pulse the card, and for how long, is not decided. The
     acceptance test should assert the selected-and-visible state, not a specific
     animation, until this is agreed.

## Current implementation default (shipped before final agreement)

The backend/gateway and palette were shipped with these defaults so development can
continue while the architect is rate-limited. They remain overrideable and are not a
commitment:

- **Scope**: global (the `boardTrail` contract already implies global).
- **Ranking**: title/URL match before body match, then title, then `entityId`.
- **Activation**: on select, navigate to the result's Board. Selecting/centering the exact
  card and any focus pulse are still open and not yet implemented.

## Files (proposed, for implementation after agreement)

- Create: `src/search/search-types.ts`, `src/search/SearchPalette.tsx`,
  `src/search/search-palette.css`, `src/search/SearchPalette.test.tsx`
- Modify: `src/services/workspace-gateway.ts`, `src/services/mock-workspace-gateway.ts`,
  `src/services/tauri-workspace-gateway.ts`, `src-tauri/src/repositories/workspace_repository.rs`,
  `src-tauri/src/commands/`, `src/navigation/TopNavigationBar.tsx`, `src/App.tsx`,
  `src/state/current-board-store.ts`, `src/canvas/CanvasAdapter.tsx`,
  `tests/e2e/canvas-smoke.spec.ts`

## Acceptance (after agreement)

- Create a Note with distinctive text, open Search with `Command-K`, choose it, and verify
  the Note becomes selected and visible.
- A Link is found by `title`, `URL`, and `description`.
- A Board is found by `title` and navigates to its last viewport.
- Trashed entities never appear.
