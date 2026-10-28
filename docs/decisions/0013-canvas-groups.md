# ADR-0013: Canvas Groups — a Frame Card with Geometric Membership

- **Status:** Proposed (2026-10-28), to be accepted with the PR that ships it
- **Date:** 2026-10-28
- **Source:** `tasks/todo.md`, «Следующие фичи — зафиксировано 2026-09-25» →
  «Группы (подложка с названием), как в Obsidian Canvas»; user request of
  2026-10-28 («объединения заметок в группы как в обсидиан на холсте»)

## Context

Milanote and Obsidian Canvas let the user draw a named, coloured frame under a set
of cards. Dragging the frame drags everything inside; dragging a card across the
frame's edge moves it in or out. The frame is a visual region, not a container
with an owner list: nothing is "inside" a group except by position.

MySpace has no z-order management beyond `cards.z_index`, no card kind that may be
larger than 1600 px wide, and no notion of one card moving others. Two ways to
model a group were considered:

1. **Stored membership** — a `group_members(group_id, card_id)` table maintained on
   every move. Rejected: it duplicates what the geometry already says, it needs a
   write on every drag end for every card that crossed a border, and it creates a
   second truth that sync replay would have to reconcile with positions.
2. **Geometric membership** — the group is an ordinary card of a new kind; a card
   is a member if and only if its frame lies inside the group frame at the moment
   the question is asked. Chosen.

## Decision

### Domain

- New card kind `group`, registered in `src-tauri/src/domain/card_kind.rs` and
  `src-tauri/src/domain/kinds/group.rs` through the existing `CardKindHandler` /
  `DetailTable` machinery. Detail table (migration `0028_group_cards.sql`, additive):

  ```sql
  CREATE TABLE group_cards (
      card_id     TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
      title       TEXT NOT NULL DEFAULT '',
      color_token TEXT NOT NULL DEFAULT 'default'
          CHECK (color_token IN ('default','yellow','pink','lavender','blue','green','gray'))
  );
  ```

  plus the `change_seq` trigger set every detail table has (see `0023`). The
  colour tokens are the note palette; the board palette is the same seven ids in
  CSS. An empty title renders as «Группа без названия» on the frontend and is
  stored as `''`, never as a localized string.
- `group` is a **leaf** kind (`CardKind::LEAF`): it can be trashed, restored,
  moved to another board or to Unsorted, copied by `duplicate_board` via
  `copy_detail`, exactly like a shortcut card. It is **not** searchable in v1
  (no `search_rows`); adding the title to FTS is a follow-up.
- Mutations (all `is_local_only() == false`, all through the single writer):
  - `CreateGroup(CreateGroupInput { id, board_id, frame, title, color_token })`
    → `MutationOutcome::Card(CardDto)`; idempotent by client id like
    `create_board_shortcut`.
  - `UpdateGroup(UpdateGroupInput { card_id, expected_revision, title?, color_token? })`
    → `CardReceipt`; `stale_revision` on mismatch.
  - Move and resize reuse the existing `MoveCards` / `update_card_frame` paths —
    a group frame is a card frame.
  - Trash/restore/ungroup reuse `TrashSelection` / `RestoreTrashBatch`.
    **«Ungroup» is `TrashSelection` of the group card alone.** Members are not
    touched; they keep their positions. Trashing a group through the Delete key
    behaves the same way: only the frame goes to trash.
- Frame limits: `Frame::MAX_WIDTH` rises from 1600 to 8000 for every kind (the
  mock gateway's copy of the constant follows). A group frame is routinely wider
  than 1600 px; keeping a per-kind limit would put the kind into `Frame`, which
  today knows nothing about kinds. `MAX_HEIGHT` stays 10000.

### Membership and movement (frontend only, no persistence)

- `isInsideGroup(card: Frame, group: Frame): boolean` — the card's whole frame is
  inside the group frame (all four edges, no tolerance). A group inside another
  group is a member of the outer group. A group is never a member of itself.
- Dragging a group: at drag start the frontend computes the member set once,
  moves members visually with the frame during the drag, and on drag end issues
  **one** `MoveCardsCommand` with the group and every member (atomic, one undo
  step; a `stale_revision` on any card rolls back all of them, as `move_cards`
  already guarantees). Members are not auto-selected; selection stays as it was.
- Dragging a card: nothing group-specific happens. Crossing the border changes
  membership for the next computation; no write.
- Dragging a group into another group's area moves only the dragged group and
  its own members.
- **Overlapping groups (rule added 2026-10-28 after the first user check).** A
  card whose frame lies inside two groups belongs to *both* only when one of the
  groups is nested in the other (its whole frame inside the other's); then the
  outer group moves the inner one together with its cards, and the inner group
  moves its own cards alone. When the two group frames overlap only partially
  (neither contains the other), a card inside both is *contested* and moves with
  neither group: it stays where it is when either frame is dragged. Without this
  rule a group dragged over another one carried away every card it happened to
  cover. The alternative — give the card to the smaller (or topmost) group —
  was rejected because it reproduces exactly that: the dragged, usually smaller,
  group would still take the cards of the one underneath. Two groups with
  identical frames count as nested in both directions. `groupMembers` in
  `group-membership.ts` implements this; nothing is stored.
- Resizing a group (corner handles, same `ResizeCardCommand` path as images,
  wired through a new `use-group-edits.ts` hook rather than `use-card-edits.ts`)
  never moves cards; shrinking the frame simply drops members. Auto-expansion
  when a member is dragged beyond the border is explicitly out of v1.

### Z-order and hit-testing

- Group nodes get a React Flow `zIndex` in a dedicated band below all other
  kinds: `-10000 - floor(width * height / 10000)`, so a group is always under
  every non-group card regardless of what `cards.z_index` says, and a smaller
  (nested) group is always above the larger group that contains it. Selection
  never changes a group's z (React Flow's `elevateNodesOnSelect` is off; the
  +1000 lift for selected non-group cards is applied by the mapping itself).
- The frame body is the node; a click on an empty area inside the frame selects
  the group, and a drag there moves it. Marquee selection cannot start inside a
  frame (Obsidian behaves the same way), and the canvas context menu («New note
  here», «Paste») is not reachable inside a frame either: right-click there opens
  the group's menu. Marquee started outside and crossing the frame uses
  `SelectionMode.Partial` as today and therefore selects the group too;
  «Ungroup» and Delete act on the group only, as stated above.

### Creation UI

- Select one or more cards → context menu «Group» (also `Cmd/Ctrl+G`). The frame
  is the selection's bounding box plus 24 px padding on each side and 36 px extra
  on top for the title chip. z_index of the new group = 0.
- Context menu on a group: «Rename» (inline edit of the title chip, also on
  double-click of the chip), colour submenu (seven tokens), «Ungroup»
  (`Cmd/Ctrl+Shift+G`), «Delete».
- The floating toolbar from the reference screenshot (trash / palette / search /
  align / edit / image) is not part of this ADR; MySpace has no floating toolbar
  yet and adding one is a separate decision.

### Connectors

A group is a card, so connectors (the `connectors` entity shipped in the same PR)
may start or end on a group frame. No special casing.

## Consequences

- Positive: one new table, no membership bookkeeping, sync and trash work with
  zero connector-style special cases, undo is the existing `MoveCards` undo.
- Negative: membership is recomputed on the frontend from positions; a group
  that is partly covered by another group has ambiguous ownership resolved purely
  by geometry (both outer groups move it). Acceptable for v1.
- Negative: raising `MAX_WIDTH` for every kind lets a note be 8000 px wide; the
  resize handles cap the visible range, and the limit exists to catch corrupt
  input, not to constrain design.
- Risk: large groups with many members produce one `MoveCards` of N frames on
  drag end; `move_cards` already handles the 500-card selection path.

## Out of scope / follow-ups

- Auto-expand on member drag, snapping members to the frame.
- Group title in full-text search.
- Floating selection toolbar.
- Collapsing a group.
