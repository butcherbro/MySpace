# ADR-0001: Visual Workspace V1 Scope

- **Status:** Accepted
- **Date:** 2026-08-28
- **Source:** `docs/plans/2026-08-28-visual-workspace-v1.md`

## Product thesis

This is a **spatial project surface**, not a dashboard, file explorer, graph
editor, or generic second brain.

`Home` is itself a board. A user places notes and child-board portals anywhere
on it. Opening a portal replaces the current canvas with the child board while
preserving hierarchy through breadcrumbs and back navigation. Every board
remembers its own layout and viewport.

The first release answers one question: **is it more comfortable to think and
organize daily work through nested spatial boards than through folders and
linear documents?**

## V1 scope

- Infinite two-dimensional canvas with a quiet dotted background.
- Note cards with inline rich-text editing.
- Board portal cards that open child boards.
- Unlimited logical nesting, with cycle prevention.
- Breadcrumb and browser-style back/forward navigation.
- Pan, pinch zoom, drag, width resize, selection, multi-selection, delete, and
  note duplication.
- Per-board viewport persistence.
- Autosave and crash-safe SQLite transactions.
- Session undo/redo for canvas operations; editor-local undo/redo for text.
- Soft-delete Trash and local database backups.
- One local user, one visible workspace, and one window.

The schema retains a workspace namespace so future import/export can create an
isolated staging workspace without changing every foreign key; V1 exposes no
workspace switcher. V1 bootstraps exactly one workspace ID into Rust application
state, every command is pinned to that ID, and no V1 command or migration may
create a second workspace row after first-run initialization.

## Core Prototype versus V1 hardening

- **Core Prototype (Slices 0–4):** durable Home, useful notes, natural canvas,
  nested boards, breadcrumbs, exact reopen. The first product-learning
  checkpoint.
- **V1 hardening (Slice 5):** undo/redo, soft delete with immediate recovery,
  visible save failures.
- **V1.1 safety backlog (Slice 6):** backup recovery, measured large-board
  budgets, release packaging. These do not block validating the spatial
  product.

## Pointer and selection semantics (fixed for V1)

- Pointer down selects the card. Release without crossing a 4 CSS px threshold
  makes a Note enter editing at the clicked text position.
- Crossing 4 CSS px before release becomes a card drag and does not enter
  editing. No double click or dedicated drag handle is required.
- `Shift+click` toggles selection without entering editing or opening a board.
- Dragging empty canvas creates a partial-intersection marquee selection.
- `Cmd+A` selects all cards only when canvas owns focus.
- Notes and Board Portals may be moved together.
- Entering Note edit mode makes that Note the sole selected card. `Escape` exits
  editing and leaves it selected.
- Delete on a mixed selection soft-deletes Notes and treats every selected
  Board Portal as an explicit Board-deletion request, with one confirmation
  showing how many Board subtrees are affected.

Clipboard semantics are intentionally narrow: normal macOS text copy/paste
works while the editor owns focus. Canvas-level card copy/paste is deferred; V1
provides an explicit Duplicate command for selected notes only.

## Explicit non-goals

- Files, folders, images, link previews, filesystem shortcuts, or external
  mounts.
- LLM integration, agents, tool calling, or generated content.
- Cloud sync, collaboration, accounts, authentication, sharing, or web access.
- Tags, status, tables, gallery views, global search, tasks, columns, drawing,
  arrows, or comments.
- Public plugin SDK or user-installable card types.
- Duplicate Board and Board Shortcut. V1 can duplicate notes; board copying is
  deferred because ownership and deep-copy semantics must be designed
  separately.
- Mac App Store distribution. V1 is a local development build, followed by a
  signed/notarized direct download when distribution matters.
