# Packaged acceptance runbook — v1 stabilization

Run this once, in order, on the built app. It is the only step of the
stabilization that a machine cannot do: every automated gate runs headless
against an in-memory mock or a temporary database, so nothing below has been
verified in a real window. Budget about 25 minutes.

## 0. Which build

`npm run tauri build` from the worktree produces
`src-tauri/target/release/bundle/macos/myspace.app` — verified here: 26 MB, release
profile, `com.bro.myspace` 0.1.0, frontend embedded, built with the new CSP in place.
Launch the `.app`, not `tauri dev`: the dev loop serves the frontend from Vite and
substitutes neither bookmark durability nor the injected CSP. The build is
unsigned, which is fine for acceptance — signing is a separate concern.

The `.dmg` step (`bundle_dmg.sh`) fails with `hdiutil: create failed - Operation not
permitted` when the build runs inside a sandboxed shell; that is an environment limit,
not a project defect, and the `.app` beside it is complete. Nothing in acceptance needs
a disk image — run the build from a normal terminal if you want one.

Before starting, note where the live library is:
`~/Library/Application Support/com.bro.myspace` (database `workspace.sqlite3`,
managed files in `assets/`). Every launch takes a snapshot into `backups/` first,
so a run is recoverable.

## 1. CSP — `docs/testing/security-hardening-manual.md` (11 steps)

The riskiest item, because the failure mode is silent: a missing source shows up
as a blank window, an empty image, or a frame that never renders. Walk all eleven
steps. The two that matter most:

- **IPC works** (create/edit a note, reload, text is still there) — this is the
  one CSP source that could not be verified from the code.
- **The HTML File Card preview renders inside its frame**, and a page containing
  `<script>alert(1)</script>` does not run its script.

If something is broken here, the fix is one config value: set `csp` (and `devCsp`)
back to `null` in `src-tauri/tauri.conf.json` and report it.

## 2. Folder shortcut — `docs/testing/folder-shortcut-manual.md`

Bookmark durability across restart, folder moved or renamed outside the app,
access revoked, and open-in-Finder. The earlier handoff claimed plain bookmarks
fixed the `constraint_violation` regression, but only a packaged restart proves
the bookmark that macOS actually wrote still resolves.

## 3. Close-flush — `docs/testing/close-flush-manual.md`

Type a word, close within a quarter second, reopen: the word is there. Then the
failure path (make writes fail, close, choose **Stay**), and the escape hatch
(press `Cmd+Q` twice — the second press must close without asking).

## 4. File Cards of every kind (Task 20 addition)

For each of: a text file, a large log, a PDF, an Office document, an `.html` file,
and a ZIP:

1. drag it onto a board — a File Card appears with a sensible preview or tile;
2. open it (the card's open action) and reveal it in Finder;
3. **quit and relaunch, then confirm every one of them still renders and still
   opens.** This is the part that would have caught the asset-loss incident.

## 5. Favicon reuse (Task 20 addition)

Drop three or four different YouTube links from the same channel onto a board.
They must share one favicon. Machine-checkable support: on the live library today,
14 Link Cards share **2** favicon files, and the startup collapse is idempotent
(13 assets → 2 on the first run, no further change after).

## 6. Mixed cross-board movement, then restart (Task 20 addition)

Marquee-select a mix of cards — notes, an image, a link — and drop the group on
another board's tab, then on a breadcrumb. It must move as one action, with no
partial move, and `Cmd+Z` must undo the whole group. Restart and confirm the
result survived.

## 7. Visual shell — `docs/testing/visual-shell-manual.md`

A quick eye pass on the Quiet Desk chrome, plus the dense board at `?fixture=dense`
in the dev build if you want the scrolled case.

## 8. What to report back

- Any step that failed, with what you saw;
- whether the live library looked right after the run (the app writes there);
- and, for the architect, the two open questions recorded in the stabilization
  report: the macOS `connect-src` requirement for IPC, and whether the favicon
  source URL should be stored durably (ADR-0008).

Merge to `main` waits on this run plus the architect's review of the final diff.
