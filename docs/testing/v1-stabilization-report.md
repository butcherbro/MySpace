# V1 stabilization report — evidence

Everything here was produced by a command or a test at the revision named below.
Where a claim is not backed by a run, it says so explicitly instead of reading as
fact. This file is the evidence behind `tasks/current-state.md`, the single
source of truth for status.

## Revision

- Branch: `codex/v1-stabilization`, created from `main@d174e6b` (which contains the
  plan; `5101f18` is its ancestor).
- Revision for the automated evidence: **`4292e3a`**, the last product revision (61
  commits on the branch). The gates were re-run unchanged after the documentation
  commit that followed it; documentation changes no code, so the results below
  stand for both.
- Worktree: `/Users/bro/Projects/MySpace/.wt-v1-stabilization`, clean
  (`git status --short` empty).

## Automated gates at `4292e3a`

| Command | Result |
| --- | --- |
| `npm run check` (typecheck + lint + vitest) | **330 tests passed, 54 files**, lint clean with no warnings, typecheck clean |
| `npm run test:e2e` | **39 passed** (Chromium, mock gateway), no unexpected console/page errors — the shared fixture fails a test on any |
| `npm run build` | built; main chunk **893.46 kB** (274.11 kB gzip) |
| `npm audit` | **found 0 vulnerabilities** |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | clean |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | clean |
| `cargo test --manifest-path src-tauri/Cargo.toml` | **173 passed, 0 failed** across 17 integration test files |

`npm run tauri build` was also run: the release application builds and the `.app`
bundle is produced (26 MB, `com.bro.myspace` 0.1.0, frontend embedded) **with the new
CSP in place**, so the policy string is accepted by Tauri's codegen. The `.dmg` step
fails inside this sandbox (`hdiutil: create failed - Operation not permitted`) — an
environment limit, not a project defect; acceptance uses the `.app`.

### The same gates from a clean checkout

The table above was produced in the working tree, where warm state can hide a
problem: a file that was never committed, a lockfile that drifted, a build output
that flatters the result. The plan asks for a fresh state, and since the repository
has no remote, CI has never run — so it was done by hand:

1. `git clone --local --branch codex/v1-stabilization` into an empty temp directory,
   landing on exactly the revision above with a clean status;
2. `npm ci` from the lockfile — installed clean, **0 vulnerabilities**;
3. `npm run check` — **330 passed, 54 files**;
4. `npm run build` — ok;
5. `npm run test:e2e` — **39 passed**.

The temp checkout was removed afterwards (the volume is at 99% capacity, and a
second Rust target directory would have cost several GB). The Rust side is covered
by the release build above: it had no cached artifacts, so every dependency was
compiled from zero in that run.

Not verified in this environment: **Rust dependency advisories**. `cargo-audit`
is not installed and the sandbox has no cargo registry access, so nothing here
claims the Rust dependency tree is free of known vulnerabilities. That check
belongs in CI or on a machine with registry access.

## What the stabilization covered

One commit per task, in plan order. The data-integrity fixes are deliberately not
squashed together with the refactors, so each stays reviewable and revertible.

| Task | Commit | Effect |
| --- | --- | --- |
| 2–3 | `40a6904`, `026ff67` | GC knows every durable asset owner (`file_cards.asset_id`, `file_cards.preview_asset_id`); ordered delete; startup sweep logs `asset-gc:` and converges |
| folder shortcut | `4b53aee`, `6ba3f5e`, `c04553a`, `c5f87c8`, `81b1789` | plain bookmarks (ADR-0006): security-scoped creation fails on non-sandboxed macOS; diagnostics preserved |
| 4 | `84f7e13` | bounded file previews, shorter database locks |
| data recovery | `43263bb` | guarded recovery script for a missing managed asset |
| 5 | `c2f6ab2` | file card thumbnails return without a reload |
| 6 | `6e25850` | stale workspace search responses ignored |
| 7 | `2045f00` | viewport saves isolated per board |
| 8 | `6f92d4e` | native drop subscriptions balanced |
| 9 | `0df52d8` | cross-board drag finishes after canvas replacement |
| 10 | `ae034ce`…`21a5f8f` (21 commits incl. `d268910`, `c3f2f56`) | mixed selection moves as one atomic command (ADR-0007); the wire types, both gateways, the command and both UI entrances |
| 11 | `0c9b5b3`, `ecfddeb` | frontend and Rust quality gates restored; clippy cleanup |
| 12 | `8c1790c` | e2e fails on browser runtime errors and cannot reuse a stale server |
| 13 | `94f1870` | one non-deploying CI gate |
| 14 | `62f543d` | favicon dedup by stored bytes (ADR-0008) |
| 15 | `255f2bb` | Unicode-safe search excerpts |
| 16 | `5c4d90a` | close-flush: the window waits for pending writes |
| 17 | `929b6e8`, `4cc6a5c`, `f8d3604`, `66e8a96`, `e41abd4`, `7f71de5` | `App.tsx` 2499 → 2080 lines, six controllers, command orchestration still in App |
| 18 | `aebdfc7`…`9ac9cb9` | `workspace_repository.rs` 2601 → 14 lines, seven aggregate modules, public paths unchanged |
| SECURITY-HARDENING | `4292e3a` | production CSP + `devCsp`; `sandbox=""` preview guard test; packaged checklist |

## Plan compliance, step by step

The commit list proves each task landed; it does not prove each task's *steps* did.
Audited against the plan text, so a reviewer does not have to re-derive it:

| Task | Step-level requirement | Where it stands |
| --- | --- | --- |
| 4 | bounded read via `File::open().take(limit + 1)` | `read_text_preview` does exactly that; `read_text_preview_reads_a_bounded_head_of_large_files` |
| 4 | failure cleanup for unknown board, conflicting card id, failed insert, thumbnail failure | all four cases covered in `tests/asset_service.rs` |
| 5 | return the persisted DTO, not a rebuilt one | `load_card` in the command; `preview_asset.expect("the generated thumbnail is projected")` plus the gateway test |
| 6 | deferred-promise latest-request-wins test | `use-workspace-search.test.ts` drives two deferred requests |
| 7 | board-switch test for the captured revision | `writes the board id and revision captured when the viewport settled` |
| 8 | cleanup-before-listen test | `tears down a listener that registers after cleanup and never delivers to it` |
| 9 | component regression test + e2e | `finishes a drag whose node disappeared with the snapshot without throwing` |
| 11 | document the selected package versions | commit body records that no ESLint/typescript-eslint change was needed, per the architect's ruling |
| 14–18 | as written | see the commit map above; Task 18's one deviation is below |

Three deliberate deviations, stated rather than buried:

1. **Task 9's page-error step was superseded by Task 12.** It asked for a
   `pageerror` collector in `tab-drop.spec.ts`; Task 12 replaced it with a shared
   auto-fixture that fails *every* spec on a runtime error, which is strictly
   stronger than one spec having its own collector. The spec keeps a comment
   saying where the guard now lives.
2. **Task 18 asked for a `trash.rs` module; none was created** because this
   repository file had no trash code — trash lives in `domain/trash_service.rs`
   and only calls cards and boards here. Inventing an empty module to match a
   suggested file list would have been noise.
3. **Task 9/11 fix commits were not entangled with refactoring**, as the plan's
   commit-order section requires: every data-integrity commit touches only
   modified or newly added files, with no renames or moves, so each stays
   independently reviewable and revertible.

## The asset-loss incident

- **What happened.** Before the fix of Task 1–2, the startup asset GC did not know
  that File Cards own assets, so it treated their files as orphans and deleted
  them. One File Card asset was lost this way; the card kept its row and its
  metadata, so the loss showed up as a card that would not render.
- **How it was recovered.** A startup snapshot taken before the damaging run
  contained the file. It was restored by a parameterized ops script
  (`scripts/recover-missing-asset.py`, dry-run by default, `--apply` requires
  `--confirm-app-closed`) that verifies the backup manifest, the recorded size,
  the source and destination SHA-256, refuses to overwrite, and rejects unsafe
  paths. After the copy, a full integrity check passed and no asset was left
  missing.
- **Deliberately not recorded here:** asset ids, filenames, and any note content.
  They are private data; the recovery detail lives in the session handoff, which
  is not published.
- **Machine-checkable half, verified read-only on the live library afterwards:** all
  91 durable asset references (image cards, link previews, link favicons, board
  covers, file cards) resolve to files that exist; `integrity_check: ok`; schema 17.
  Rendering itself still needs the packaged run.
- **Approval reference.** The restore ran only after explicit user confirmation,
  with the application closed, and only against the live library; the plan's
  destructive-test rule (never test destructive behaviour against the live
  database or assets) held throughout — every automated test uses temporary
  databases and asset directories.

## Live-data events caused by running the app

Running the app from the worktree has twice changed the live library, both times
by intended code paths:

1. **Startup migrations** when the app first ran from the branch (schema 15 → 17),
   preceded by an automatic snapshot.
2. **Favicon collapse** (Task 14's fix) on a restart at 12:44: 13 favicon assets
   became 2, 13 page-URL cache rows were removed, and the GC deleted 11
   byte-identical duplicate files. Verified afterwards: every card resolved to an
   existing asset, no card's image bytes changed, `integrity_check: ok`, and the
   pre-change snapshot was intact.

Both are recorded because a reviewer must be able to tell deliberate convergence
from an accident.

## Packaged acceptance — outstanding

Nothing in the automated gates can see the packaged application, and the browser
suite runs the mock gateway, so these remain manual and are the reason Task 20
exists:

- `docs/testing/folder-shortcut-manual.md` — bookmark durability across restart,
  move, revoke, and Finder open.
- `docs/testing/security-hardening-manual.md` — CSP: IPC, `myspace-asset:` images,
  the sandboxed HTML preview, thumbnails, folder shortcut, search, trash,
  close-flush, dev loop.
- `docs/testing/close-flush-manual.md` — the window really waits for a pending
  draft, and the failure dialog behaves.
- `docs/testing/visual-shell-manual.md` — the Quiet Desk shell by eye.
- `docs/testing/e2e-harness.md` — how the browser harness is built and what it
  cannot see.

`tauri dev` is not evidence for bookmark durability or for CSP, which is why these
are checklists and not tests.

## Residual debt, separated from wishlist

### Correctness debt still open

| Item | Owner | Why it is still open |
| --- | --- | --- |
| CSP confirmation by the architect | user → architect | The policy is derived from the code and applied, but the exact IPC source requirement on macOS WKWebView can only be confirmed in a packaged run, which has not happened yet |
| Packaged acceptance for CSP, close-flush, folder bookmarks | user | Needs a human at the packaged app; no automation can substitute |
| A previewed HTML file has no CSP header of its own | — | Recorded as a residual risk in the security checklist: remote subresources stay fetchable (privacy, not script execution) |
| Favicon source URL is still not stored per card | user → architect | ADR-0008: the repair did not need it; the architect question is deferred by the user's instruction |
| e2e cannot reproduce stale-local-revision bugs | — | The mock keeps state and snapshot in one graph (documented in the e2e harness note); covered by gateway/command unit tests and backend rejection tests |

### Wishlist, deliberately not done

| Item | Reason |
| --- | --- |
| Bundle splitting | The main chunk is 893 kB; performance work, not correctness. Planned as a later slice with lazy editor mounting |
| Duplicate board/card ("copy like the Finder") | Feature request, not debt |
| Plain-text precision for lists and code blocks | Deferred until export/search needs it; `documentJson` stays authoritative, so no data is lost today |
| Rust dependency advisory scan | Needs cargo registry access; belongs to CI |
| Migrating the 187 `workspace_repository::…` call sites to the new aggregate modules | Shorter paths, no behaviour; the re-export facade keeps them working |
