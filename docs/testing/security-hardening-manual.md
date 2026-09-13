# Security hardening — packaged macOS acceptance

The CSP in `src-tauri/tauri.conf.json` is injected by Tauri into the built
application only. The browser suites (`npm run test:e2e`) run the frontend with
the mock gateway and never see it, so **a CSP mistake is invisible to every
automated gate** and can only be caught here, by hand, in the packaged app.

## What was enabled

`app.security.csp` (production) and `app.security.devCsp` (development, looser:
Vite injects inline styles and the React Refresh preamble, and HMR needs the
websocket). `dangerousDisableAssetCspModification` stays unset, so Tauri still
parses the built assets and adds nonce/hash sources for our own scripts and
styles.

Production CSP, and why each source is needed:

| Source | Reason |
| --- | --- |
| `default-src 'self'` | the app is a self-contained bundle; nothing remote is loaded |
| `script-src 'self'` | bundled JS only; the code has no `eval`, no `new Function`, no inline handlers, no `dangerouslySetInnerHTML` |
| `style-src 'self'` | CSS is imported statically; runtime `<style>` injection was checked and does not exist (no `style-mod`, React Flow CSS is imported) |
| `img-src 'self' myspace-asset:` | every image, cover, thumbnail and favicon is served over the custom asset scheme |
| `frame-src myspace-asset:` | the HTML File Card preview is the only frame in the app |
| `connect-src 'self' ipc: http://ipc.localhost` | Tauri IPC; on macOS the webview talks to Rust through a message handler, so these are belt-and-braces rather than certainly required — the item below is what proves it |
| `object-src`, `base-uri`, `form-action`, `frame-ancestors` `'none'` | nothing in the app embeds objects, uses `<base>`, posts forms, or is meant to be framed |

## Run this after building (`npm run tauri build`, or `npm run tauri dev` for a first pass)

1. **The app boots at all.** A wrong `default-src`/`script-src` shows a blank
   window: that alone is the first check.
2. **IPC works** — this is the item the CSP could plausibly break, because it is
   the one source that could not be verified from the code alone. Create a note,
   edit its text, and reload: the text is in SQLite. Create a board, rename it,
   move a card between boards, undo it.
3. **Images render**: import an image (picker *and* Finder drop), and check a
   board cover, a search-result thumbnail and a trash thumbnail — all are
   `myspace-asset:` images. A CSP that is missing `myspace-asset:` in `img-src`
   shows empty frames here and nowhere else.
4. **The HTML File Card preview loads**: drop an `.html` file on a board. The
   card must show the rendered page inside the frame. This is the only
   `frame-src` consumer; without `myspace-asset:` there, the frame stays blank.
5. **The preview stays sandboxed.** In the packaged app's web inspector, the
   frame element must still read `sandbox=""`, and a page containing
   `<script>alert(1)</script>` must not run its script. The automated guard for
   the attribute is `src/cards/file/FileCard.test.tsx`.
6. **PDF and office thumbnails** render (they are `preview_asset` images).
7. **Folder shortcut**: drop a folder, its preview lists entries, and
   "Open in Finder" opens it.
8. **Search** returns notes, links, images and folder aliases.
9. **Trash**: trash a note and a board, restore the batch, empty the trash with
   the typed confirmation.
10. **Close with a pending edit**: type a word and close within a quarter second;
    reopening shows the word (the close-flush path runs `destroy` — see
    `docs/testing/close-flush-manual.md`).
11. **Dev loop still works**: `npm run tauri dev` reloads on a file edit and HMR
    applies without console errors — that is what `devCsp` is for.

If any step fails, revert `app.security.csp` to `null` and `devCsp` with it: the
CSP is one config value, not a code path.

## Known residual risks (deliberately not changed here)

- **A previewed HTML file has no CSP of its own.** The asset protocol serves it
  with no `Content-Security-Policy` header, so a local HTML file can still
  reference remote subresources (images, fonts) — a privacy leak to the file's
  author, not a code-execution risk, since `sandbox=""` blocks scripts. Giving
  HTML asset responses their own restrictive CSP header is a possible follow-up;
  it was out of scope for this change and would need its own review.
- **One capability for one window.** Path-taking commands (`import_asset`,
  `create_folder_alias`, `create_file_card`, `classify_drop_paths`,
  `open_file_card`, `reveal_file_card`, `open_folder_in_finder`) are scoped to the
  `main` window, which is the only window. The rule that keeps that safe is: a
  window hosting untrusted content never gets a capability.
