# MySpace

A spatial project surface. A macOS desktop app where notes and child-board
portals live on an infinite canvas, and every board can contain other boards.

## What it is

- `Home` is itself a board. Place notes and child-board portals anywhere on it.
- Opening a portal replaces the current canvas with the child board, while
  breadcrumbs and back/forward navigation preserve the hierarchy.
- Every board remembers its own layout and viewport, and everything survives a
  restart via SQLite.

The first release should answer one question: **is it more comfortable to think
and organize daily work through nested spatial boards than through folders and
linear documents?**

## Stack

- **Tauri 2** (Rust) application shell with a system WebView.
- **React + TypeScript** (Vite) frontend.
- **React Flow** for canvas mechanics, isolated behind a `CanvasAdapter`.
- **SQLite** as the authoritative source of truth.
- **Tiptap** (open-source packages only) for rich-text notes.

## Status

Early implementation. See `docs/plans/2026-08-28-visual-workspace-v1.md` for the
full V1 plan and `docs/decisions/` for architecture decision records.

## Development

```bash
npm install
npm run tauri dev
```

## Quality gates

```bash
npm run check            # typecheck + lint + unit tests (vitest)
npm run test:e2e         # browser-mode flows (playwright)
cargo test --manifest-path src-tauri/Cargo.toml
```

Individual scripts:

| Script | Purpose |
|---|---|
| `npm run typecheck` | TypeScript --noEmit |
| `npm run lint` | ESLint |
| `npm test` | Vitest (headless unit/component tests) |
| `npm run test:ui` | Vitest watch mode |
| `npm run test:e2e` | Playwright browser flows |
| `npm run check` | typecheck + lint + test |
