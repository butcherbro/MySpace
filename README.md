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

`npm run tauri dev` — dev loop with hot reload.
`npm run release` — builds the .app and installs it to /Applications/MySpace.app.

## Platforms

macOS is the primary target and the required CI job. Windows and Linux build
and pass the Rust gates in CI (`windows-cargo`, `linux-cargo`); see
`.github/workflows/ci.yml`.

### Windows

Works the same as macOS (cross-platform code, no platform branches):
canvas, boards, notes, links, image/file cards, SQLite, backups, search, the
`myspace-asset` protocol (served as `http://myspace-asset.localhost/…` by
WebView2 — `src/services/asset-url.ts` picks the URL form, the CSP allows both).

Platform-specific, with a Windows implementation:

| Feature | macOS | Windows / Linux |
|---|---|---|
| Folder shortcut locator | Plain Foundation bookmark (follows renames/moves, ADR-0006) | `path:v1:<canonical absolute path>` (`PathLocator`); a moved/renamed folder shows as unavailable until dropped again. A blob from the other format resolves to a clear `ForeignFormat` error and the "unavailable" state, never a panic (ADR-0012). |
| Open folder / open file / reveal file | `tauri-plugin-opener` (`open`, Finder selection) | `tauri-plugin-opener` (Explorer / default app / `SHOpenFolderAndSelectItems`; `xdg-open` + FileManager1 on Linux) |
| Copy text (link, file path) | `NSPasteboard` | `arboard` (Linux needs an X11/XWayland display) |
| Copy Image (image cards as files) | `NSPasteboard` file URLs | `arboard` file list (`CF_HDROP` on Windows, `text/uri-list` on X11); falls back to newline-separated paths as text |
| Paste a path onto the canvas | `/…`, `~`, `~/…` | also `C:\…`, `C:/…`, `\\server\share…`, `~\…`, and Explorer's quoted "Copy as path" output; `~` expands against `HOME`, else `USERPROFILE` |

Not implemented off macOS yet:

- Office/PDF thumbnails on File Cards (Quick Look `qlmanage`); the card shows
  no thumbnail.
- Pasting an image from the clipboard (`read_clipboard_image`) returns an error.
- `npm run release` (installs into `/Applications`); build a Windows bundle
  with `npm run tauri build` by hand.

Needs a human on Windows (CI cannot exercise UI or the clipboard): drag a
folder in and open it, open/reveal a File Card, "Copy File Path" and "Copy
Image" then paste into Explorer/a chat app, paste `C:\…` and a quoted
path onto the canvas, check that images and `.md`/`.html` previews load.

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
