# ADR-0010: Board Shortcuts — Alias, Not Ownership

- **Status:** Accepted
- **Date:** 2026-09-18
- **Source:** `tasks/todo.md` №17

## Context

A Board Portal (`board_portal_cards`) both *displays* a child board and
*owns* it: trashing the portal trashes the board's whole subtree
(`trash_service::trash_board`), and a board has exactly one portal (its
parent placement). Milanote-style workflows want a second thing: a board
that lives in one place but is reachable from several others — a shortcut,
like a Finder alias, that never owns the board it points to.

The two entities must not be confused: deleting a shortcut must never affect
the board it points to, and deleting/moving the board it points to must be
decidable independently of how many shortcuts exist.

## Decision

A new card kind, `board_shortcut`, backed by `board_shortcut_cards(card_id
PRIMARY KEY, target_board_id NOT NULL REFERENCES boards(id))` — no
`ON DELETE CASCADE`, no ownership semantics. Unlike `board_portal_cards`, a
board may have any number of shortcuts pointing at it (no uniqueness
constraint on `target_board_id`), and a shortcut is a perfectly ordinary leaf
card everywhere the domain enumerates leaf kinds (move to/from Unsorted,
cross-board move, trash-as-a-leaf, copy/paste).

**Identity is read live, never copied.** Every other place that shows a
board's identity (a Board Portal, a Quick Board chip, a Trash entry) reads
`title`/`color_token`/`symbol`/`cover_asset_id` off the live `boards` row at
render time — a shortcut does the same, via a `LEFT JOIN boards` keyed on
`target_board_id`. Renaming the target board is visible on every shortcut
immediately, with no write fan-out and no staleness window.

**The JOIN is LEFT, and produces `target: null` when the target row is gone or
trashed**, rather than failing the read. Two ways a shortcut can end up
pointing at nothing:
1. The cascade below normally trashes a shortcut in the same batch as its
   target, so this should be rare in practice — but a batch is not a
   database-level foreign key, so any accepted-but-unusual state (manual SQL,
   a future migration bug, data imported from elsewhere) must degrade
   gracefully, not panic a board snapshot read that also has to return forty
   other unrelated cards.
2. **The spec explicitly asks for this**: "если целевая доска в Trash, а
   ярлык почему-то жив (старые данные) — рендер «битого» ярлыка... без
   падения". `target: Option<BoardShortcutTarget>` is exactly that contract in
   the type system — the frontend renders a grey "Board is in Trash" tile
   instead of crashing, and a click on it does nothing.

**Trash cascade.** `trash_board`/`trash_board_in_tx` now also trash every
shortcut whose `target_board_id` is anywhere in the subtree being trashed
(the board itself or any descendant), under the *same* `trash_batch_id`. This
reuses the existing batch-restore mechanism for free: restoring the batch
brings the board and every shortcut that pointed into it back together, with
no separate shortcut-specific restore path. A shortcut trashed on its own
(`trash_note`/`trash_selection`'s leaf branch) never touches the target board
— only `board_portal_cards` ownership does that.

**`duplicate_board` copies a shortcut's card row but does not remap its
target.** When a board being duplicated contains a shortcut, the copy's
`board_shortcut_cards` row points at the exact same `target_board_id` as the
original — even if that target happens to be a board elsewhere in the same
copied subtree. Remapping would require resolving "is this target one of the
nodes I am about to duplicate, and if so which copy" for every shortcut,
symmetrically with how `board_portal` nesting is *not* symmetric (a nested
portal always duplicates its own target, because that's what portal
ownership means — the portal's target is being copied *because* the portal
was copied). A shortcut has no such ownership relationship to its target: it
is external by construction, so "the same real board, seen from a new copy of
the board that shortcuts to it" is the correct and simpler semantics, and it
matches how every other cross-reference in this codebase (an embed's URL, a
filesystem alias's bookmark) survives a duplicate unchanged.

## Consequences

- A shortcut is never itself a duplication/move source for a *nested* board —
  only `board_portal` recurses in `duplicate_board`. Copying a board full of
  shortcuts is O(shortcuts), not O(shortcuts × target subtree size).
- Search does not index `board_shortcut` (see spec below) — a deliberate
  scope cut, not an oversight.
- MCP's `read_card` returns the same `CardDto::BoardShortcut` JSON shape as
  every other kind (`kind: "board_shortcut"`, `targetBoardId`, plus the live
  `target` projection carrying `target.title`), so an agent resolving
  `myspace://card/<id>` for a shortcut gets the board it points to without a
  second call.

## Why search does not index shortcuts

A shortcut has no content of its own — its title/identity is entirely
borrowed from the target board, which is *already* a search hit (boards are
indexed by title). Indexing shortcuts too would mean every search for a
board's name returns one hit per shortcut plus the board itself: duplicate
results proportional to how many places the user happened to drop a
shortcut, with no way to distinguish "the board" from "a shortcut to the
board" in the result list without adding new UI just for that distinction.
The board is the canonical, singular search result; shortcuts are a
navigation convenience layered on top, not a second source of truth to
surface separately.
