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
`npm run release` — builds the .app and installs it to /Applications/MySpace.app
(local, unsigned for the updater; published releases come from `.github/workflows/release.yml`).

## Platforms

macOS is the primary target and the required CI job. Windows and Linux build
and pass the Rust gates in CI (`windows-cargo`, `linux-cargo`); see
`.github/workflows/ci.yml`.

### Download

Installers are published to the public repo
[butcherbro/MySpace-releases](https://github.com/butcherbro/MySpace-releases/releases/latest):

- macOS, Apple Silicon: [`myspace_<version>_aarch64.dmg`](https://github.com/butcherbro/MySpace-releases/releases/latest)
- macOS, Intel: [`myspace_<version>_x64.dmg`](https://github.com/butcherbro/MySpace-releases/releases/latest)
- Windows 10/11 x64: [`myspace_<version>_x64-setup.exe`](https://github.com/butcherbro/MySpace-releases/releases/latest)

The builds are not notarized (macOS) or code-signed (Windows) yet: on macOS
right-click the app -> Open (macOS 15+: System Settings -> Privacy & Security
-> Open Anyway); on Windows SmartScreen -> More info -> Run anyway. After
that, the app updates itself: it checks for a new version on startup and
offers "Update and restart" (also Trash -> "Check for updates…"). How to cut
a release: `docs/release.md`.

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
- Pasting an image from the clipboard works through arboard (bitmap re-encoded as PNG, or a copied image file).
- `npm run release` (installs into `/Applications`); Windows installers come
  from the release workflow, or build one by hand with
  `npm run tauri build -- --config '{"bundle":{"createUpdaterArtifacts":false}}'`
  (see `docs/release.md`).

Needs a human on Windows (CI cannot exercise UI or the clipboard): drag a
folder in and open it, open/reveal a File Card, "Copy File Path" and "Copy
Image" then paste into Explorer/a chat app, paste `C:\…` and a quoted
path onto the canvas, check that images and `.md`/`.html` previews load.

## Sync (LAN)

Two computers on the same network (the Mac and the Windows PC on one Wi-Fi)
keep one workspace in step, peer to peer, with no server (ADR-0011 S3). Both
apps must be running; each pulls what it lacks from the other, so an edit on
one shows up on the other within about a second (a few seconds at most).

**Pairing (once per pair of computers):**

1. On computer A: Trash → **Devices…** (or the sync pill right of the search
   box) → **Pair a device**. A 6-digit code appears, valid for 5 minutes.
2. On computer B: open **Devices…**; A is listed under *On this network*.
   Click **Pair…**, type A's code, **Pair**.
3. Both now list each other under *Paired devices* and sync right away. A
   green dot means the last contact worked; *Last sync* and the last error
   are shown per device; **Sync now** runs a pass immediately; **Unpair**
   stops trusting the other device (its requests are refused from then on).

If B does not see A (mDNS blocked, guest Wi-Fi with client isolation, a VPN),
type A's address under **Add by address**: A's Devices dialog shows it as
`ip:port` (the port is chosen at random each time the app starts; a paired
device's address is remembered and refreshed on each contact).

**Windows firewall:** the first time MySpace starts on Windows, Windows asks
whether to allow it on networks. Allow **Private networks** (the home Wi-Fi
must be set to *Private* in Windows settings; on a *Public* network Windows
blocks incoming connections and mDNS, and the Mac will not reach the PC).
macOS may ask "Allow incoming network connections?" once; answer Allow.

**What is synced:** boards, all card kinds, notes, captions, trash and
restore, Empty Trash (a purge is final everywhere), board covers, Quick
Boards, and the asset files (images, file cards, previews, favicons; fetched
by SHA-256 and verified). **What is not:** device-local state (ADR-0011,
ADR-0012 `LOCAL_ONLY_TABLES`): the viewport of each board, folder shortcut
locators (a shortcut made on the Mac shows as "On <Mac>" on the PC until you
point it at a folder there), device names (each device learns the other's
name when they talk), and the pairing itself.

**Security model.** Each device has its own self-signed TLS certificate
(stored in its database, `local_meta`); its SHA-256 fingerprint is the
device's identity. All traffic is TLS 1.3 with client certificates both ways;
a request is served only if the client certificate's fingerprint is a paired
device's. Pairing exchanges fingerprints under HMAC proofs keyed by the
6-digit code (5 attempts per code, then it is void). Someone else on the same
Wi-Fi can see that MySpace runs here (device name, id and fingerprint are
advertised by mDNS) and can try to pair while a code is shown (5 guesses out
of a million); they cannot read or change the workspace without being paired.
A code is only as secret as the screen it is shown on, and an attacker who can
actively intercept traffic *during* the pairing minute could brute-force the
code offline from the proof and pair in the middle (a PAKE would close this;
see `tasks/todo.md`). After pairing, fingerprints are pinned: interception is
detected. The private key lives in the workspace database, so a backup of the
database contains it; a database copied to another machine gets a new device
id and a new certificate.

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
