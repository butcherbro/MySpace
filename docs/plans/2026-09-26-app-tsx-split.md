# Plan: split `src/App.tsx` into feature hooks

Date: 2026-09-26. Backlog item 2 of `docs/handoff/2026-09-26-local-machine.md`.

## Goal
`src/App.tsx` is 2 705 lines: about 450 lines of JSX (the `return` of `App`) and about 100
callbacks and effects in one function. Target: under 800 lines, holding JSX and hook wiring only.
Behaviour does not change.

## Rules
- One step = one commit. After every step all gates from `CLAUDE.md` are green, including e2e.
- Each hook lives in `src/app/use-<name>.ts` with its own `use-<name>.test.ts`
  (pattern: `use-canvas-paste`, `use-trash-controller`).
- Dependencies go in as one explicit argument object. No new React Context: only `App` uses these
  hooks, and a context would hide what each hook depends on.
- Keep `useCallback` dependency lists exact; do not widen them to silence lint.
  Exception: `dispatch` from `useReducer` and `useState` setters are stable, but once it is passed into a hook the linter
  can no longer see that, so it goes into the list explicitly. Behaviour is unchanged.
- Callbacks move verbatim first; cleanups go in a separate commit if at all.

## Steps (ordered by risk; line numbers refer to 2026-09-26)
| # | Hook | Moves | Lines | Risk |
|---|------|-------|-------|------|
| 1 | `use-note-formatting` | bold/italic/strike/text and note colour (1944–2002) | ~60 | low |
| 2 | `use-board-cover` | set/choose/remove cover (2026–2110) | ~90 | low |
| 3 | `use-quick-boards` | load, pin, remove, reorder, open (254–283, 1244–1296, 2111–2125) | ~120 | low |
| 4 | `use-embed-metadata` | request and retry embed metadata (199–253) | ~55 | low |
| 5 | `use-copy-actions` | copy link/path/URL/board link/selection (1476–1533, 1608–1690) | ~170 | medium |
| 6 | extend `use-canvas-paste` | paste path/cards/image (726–878) | ~150 | medium |
| 7 | `use-card-edits` | note, caption, embed description updates (879–1058) | ~180 | medium |
| 8 | `use-card-creation` | create note/link/board/image/file/shortcut, unsorted and creation drag (284–700) | ~420 | medium |
| 9 | `use-context-actions` | context menu, delete selection, duplicate, shortcut (1297–1606) | ~300 | medium |
| 10 | `use-card-drag` | move, drop on portal, drop on board tab, drag end (1059–1243, 1778–1926) | ~340 | high |
| 11 | `use-board-sync` | `applySnapshot`, reload, change polling (1691–1777, 1927–1943, 2126–2236) | ~200 | high |

Steps 10–11 touch viewport and reload state, where the "spring back" bug (todo №26) lived;
the lead session does them directly and checks by hand in `npm run tauri dev`.

## Outcome (2026-09-26)
Steps 1–11 as planned, plus:
| # | Hook | Moves |
|---|------|-------|
| 12 | `use-workspace-shortcuts` | the window keydown handler |
| 13 | `use-stable-card-handlers` | latest-ref + stable facade for card renderers |
| 14 | `use-latest-ref`, `use-canvas-pointer` (+ `useCanvasPointerTracking`), `use-unsorted-drawer` | ref mirrors, pointer tracking, Unsorted auto-open |

`App.tsx`: 2 705 → 868 lines (the undo work added ~40 lines in between). What is left is
~335 lines of JSX and ~530 lines of hook calls with their argument objects. The 800-line
target is not met; going further means splitting the JSX into components (dialogs, top bar),
which is a different kind of change and has no user-visible value now, so it is deferred.
Vitest grew from 599 to 900 tests; every extracted hook has its own test file.
