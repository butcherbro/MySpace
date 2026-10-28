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

1. **Stored membership** — the card remembers its group. Initially rejected (a
   write per border crossing, a second truth next to positions). **Chosen on
   2026-10-28** after the first user check — see «Revision 2026-10-28» below.
2. **Geometric membership** — the group is an ordinary card of a new kind; a card
   is a member if and only if its frame lies inside the group frame at the moment
   the question is asked. Chosen first, rejected after the first user check: a
   frame dragged over foreign cards captured them.

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

### Membership and movement

Superseded on 2026-10-28; the current rules are in «Revision 2026-10-28: stored
membership» below. Kept for the record: v1 as first implemented computed members
geometrically (`isInsideGroup`, every card whose frame lay inside the frame at drag
start), then added a «contested card» exception for partially overlapping frames
(commit b4adaca). Both are gone.

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

## Revision 2026-10-28: stored membership

The first user check (Евгений, verbatim): «если группу на заметку сверху поставить,
то она эту заметку затягивает в себе. Не ту, которую туда положил, а любую другую, на
которую эта выделенная область ляжет.» Earlier the same day a group dragged over
another group had carried that group's cards away. Both are the same flaw of geometric
membership: moving the *frame* changed *who belongs*, and no geometric refinement
(smallest frame, topmost frame, «contested» cards) fixes it, because the frame that was
just dragged is usually the one that now contains the card.

Product rule: **membership changes only by an action on the card itself.** A card joins
a group when the user makes a group out of a selection that contains it («Group»,
Cmd/Ctrl+G) or drops the card inside a frame; it leaves when the user drops it outside
its frame. Moving or resizing a group moves its members and never changes the member
set.

Implementation:

- `cards.group_id TEXT NULL` (migration 0029), no foreign key — sync replay may apply a
  member before its group. The column is part of the card's sync image and moves the
  `place` register (with the frame), not `body`: a membership change happens in the
  same gesture as a frame change, and `body` on notes takes part in the text-conflict
  check, so a text edit on one device plus a drop into a group on another would
  otherwise produce a conflict copy. The `place` trigger watches the column.
- A stored value is *dormant* while the group is trashed, unsorted or on another board,
  and *effective* otherwise; the loaders return `group_id` normalized (NULL when
  dormant). Trash+restore and undo of a board move therefore revive membership without
  a write. Nothing clears the column on purge; dangling values are normalized away.
- Only two mutations touch it: `MoveCards` (each item may carry `group: {groupId}`;
  absent = unchanged; one revision bump) and `CreateGroup` (`memberIds`, set in the same
  transaction, returns the group plus a receipt per member). Validation: the target is
  a live group on the same board, not the card itself, not a descendant of the card.
- Drop rule (frontend, `groupForDrop`): when a card is dropped, the smallest group frame
  that contains the card's whole frame (inclusive, no tolerance) becomes its group;
  none → it leaves its group. Only independently dragged cards are evaluated; members
  carried along by their group are not. A dragged group is evaluated like a card, so a
  small group dropped inside a bigger frame nests, and nested groups move with the outer
  frame (`groupMembers` is transitive).
- «Group» from a selection: every selected card becomes a member except cards whose
  group (or an ancestor group) is itself selected — a selected group keeps its own.
- Ungroup / Delete still just trash the frame. Undo of «Group» trashes the frame and
  writes back the members' previous membership (one `MoveCards` with unchanged frames).
- «Group» on cards that all belong to the same group G creates the new frame as a
  member of G (`CreateGroupInput.groupId`), so the cards stay nested; members with
  different (or no) groups give a top-level frame. Geometry is not consulted: a frame
  that merely covers the selected cards must not become their parent.
- A card placed back from Unsorted drops its stored membership (it is a drop outside
  any frame by definition); a cross-board move keeps the dormant value.
- A conflict copy made by sync replay is a new card outside any group.

Consequences: one nullable column, one more write only when a drop crosses a border,
nothing for sync beyond the image key; the geometric helpers shrink to the drop rule.
A 0.2.6 build ignores the unknown `group_id` key (`apply_card` reads named fields), so
rows apply and are relayed with the key intact. A `place` write made on the old device
arrives without the key; since the ADR-0011 amendment of 2026-10-28 an absent key leaves
the stored membership untouched (it used to apply as NULL and ungroup the card
everywhere), and compaction never lets such a row dominate the one carrying the key.

