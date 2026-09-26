# Search Specification

## Status

**Accepted.** This document is the product and interaction source of truth for the V1 Search
surface. The three previously-open decisions are resolved below.

## Product intent

The user keeps real material on Home and nested Boards. Search is the primary way to
relocate that material without walking the breadcrumb tree: it answers "where is that
note / link / board?" and takes the user there in one action.

## Scope (decided)

**Global.** Search spans the entire workspace (all Boards). The `boardTrail` on every
result shows where each hit lives, so a single result list stays navigable without a
board-scoped mode.

## Scope of indexed content

V1 indexes exactly these fields, nothing more:

| Entity | Indexed fields |
|---|---|
| Note | authoritative `plain_text` |
| Link Card (`embed`) | `title`, `source_url` (and `display_url`), `description_plain_text` |
| Image | caption `caption_plain_text`, asset `file_name` |
| Board | `title` |

Explicitly out of scope: asset file *contents* (binary), full-text over `document_json`
beyond the derived `plain_text`, tags, and any external filesystem content.

Trashed entities (non-null `deleted_at`) are never returned.

## Result contract

```ts
interface SearchResultDto {
  entityId: string;
  kind: "board" | "note" | "link";
  title: string;
  excerpt: string | null;
  boardId: string;
  boardTrail: Array<{ id: string; title: string }>;
  boardColorToken: string;
  boardSymbol: string | null;
  boardCoverAsset: AssetDto | null;
}
```

- `kind` is user-facing; a Link Card (`embed`) is reported as `"link"`.
- `title`: Note `plain_text` excerpt; Link `title` (fallback `source_url`); Board `title`.
- `excerpt` is a bounded match-context snippet; `null` when the match is in the title.
- `boardColorToken` / `boardSymbol` / `boardCoverAsset` let the UI group results under a
  board header rendered with the shared `BoardIdentityThumbnail` (cover → icon → acronym).

## Query behavior

- Case-insensitive substring match using `LIKE` (escaped, literal query) over the
  authoritative fields. No RegExp, no FTS at current scale.
- Empty query returns nothing.
- Results bounded (limit 50).

## Ranking (decided)

Deterministic order, applied by the backend:

1. title/URL matches sort before body matches (board/link-title rank 0, note rank 1,
   link-description rank 2);
2. then `title` (case-insensitive);
3. then `entityId` as a stable tie-breaker.

No recency or weighted score in V1.

## Result activation (decided)

On selecting a **Note** or **Link**:

1. Navigate to the entity's Board (opens/activates a tab).
2. Center the viewport on the card.
3. Select the card (existing selection ring).

On selecting a **Board**: navigate to that Board (tab like breadcrumb navigation).

**No focus pulse/animation** — center + selection is the accepted highlight (decided).

## Highlight

Matches are highlighted in the result snippets and inside the matched card. This is
UI-only state: `HighlightedText` for plain text and a transient ProseMirror decoration
for the editor. It is never written into `documentJson`, never persisted, and never
bumps a revision. It clears on query change, clear, close, or selecting a result that no
longer matches the previous query.

## Interaction

- A persistent search field lives in the top bar's right command group (before Undo/Redo).
- Typing shows a grouped dropdown (board header with thumbnail/path/count, matching
  substrings highlighted).
- 150 ms debounce; Up/Down/Enter/Escape; `Escape` clears the field.

## Acceptance

- Create a Note with distinctive text, search it, choose it, verify the Note is selected
  and visible.
- A Link is found by `title`, `URL`, and `description`.
- A Board is found by `title` and navigates to it.
- Trashed entities never appear.
- Matches are highlighted; clearing the query removes the highlight.
## 2026-09-24 update — FTS5 (P1.4)

Search is backed by an FTS5 table `search_index` (migration 0022) maintained by
SQLite triggers on `boards`, `note_cards`, `embed_cards`, `image_cards`,
`file_cards` and `filesystem_aliases`, so writes from the UI, the MCP process
and future journal replay index identically. File cards are now searchable by
file name and preview text. Matching is word-prefix (`proj` finds "Project",
diacritics ignored, Cyrillic-safe); a substring fallback runs only for queries
of at most three characters that had no prefix hit. Trashed rows stay in the
index and are filtered at query time. Ranking rules (title before body, then
recency) and excerpts are unchanged; candidates are capped at 200.
