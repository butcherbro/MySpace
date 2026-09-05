# Link Metadata Enrichment Implementation Plan

**Goal:** Turn a pending Link Card into an offline-capable preview with title, description, site name, favicon, and preview image while preserving the source URL on every failure.

**Architecture:** Note-to-Link conversion remains an immediate local transaction. A separate asynchronous Rust command reads the pending Embed, fetches metadata behind a bounded SSRF-safe HTTP boundary, caches accepted images in managed assets, and atomically writes a revision-guarded result. The React layer starts enrichment after conversion and on opening boards containing pending cards, then replaces the pending DTO with the returned authoritative DTO.

**Tech Stack:** Tauri 2, Rust, reqwest 0.13 with rustls, url 2.5, html5ever 0.38, SQLite/rusqlite, React/TypeScript, Vitest, Playwright.

---

### Task 1: Parse and validate metadata without network access

**Files:**
- Create: `src-tauri/src/domain/link_metadata.rs`
- Modify: `src-tauri/src/domain/mod.rs`
- Test: `src-tauri/tests/link_metadata.rs`

1. Write failing tests for Open Graph precedence, HTML title/description fallback, relative preview/favicon URL resolution, YouTube URL recognition, and rejection of loopback/private/link-local IP literals.
2. Run `cargo test --test link_metadata` and verify RED because the module does not exist.
3. Implement `extract_html_metadata(base_url, html)`, `youtube_oembed_url(source)`, and `validate_public_http_url(url)` with typed `LinkMetadata` output.
4. Run `cargo test --test link_metadata` and verify GREEN.

### Task 2: Add a bounded HTTP acquisition service

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/domain/link_metadata.rs`
- Test: `src-tauri/tests/link_metadata.rs`

1. Write failing tests around a transport seam for redirect validation, response-size limits, accepted image MIME types, and fallback from provider data to generic HTML.
2. Add direct dependencies already pinned in `Cargo.lock`: `reqwest = 0.13.4`, `url = 2.5.8`, `html5ever = 0.38.0`.
3. Implement manual bounded redirects, DNS/IP validation per hop, connect/total timeout, 2 MiB HTML/JSON cap, 8 MiB image cap, and image MIME allowlist (`jpeg`, `png`, `webp`, `gif`).
4. Run `cargo check --offline` and the focused tests.

### Task 3: Persist downloaded assets and metadata atomically

**Files:**
- Modify: `src-tauri/src/domain/asset_service.rs`
- Modify: `src-tauri/src/domain/models.rs`
- Modify: `src-tauri/src/repositories/workspace_repository.rs`
- Test: `src-tauri/tests/asset_service.rs`
- Test: `src-tauri/tests/workspace_repository.rs`

1. Write failing tests for storing validated downloaded image bytes and for updating an Embed from `pending` to `ready`/`failed` under an expected revision.
2. Implement managed byte-asset storage with backend UUIDv7 IDs.
3. Implement a repository read-before-fetch projection and a transactional apply method. Never overwrite `preview_origin = 'custom'`; reject stale revisions/source changes.
4. Run the focused Rust tests.

### Task 4: Expose asynchronous enrichment through Tauri

**Files:**
- Create: `src-tauri/src/commands/link_metadata.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/tests/link_metadata.rs`

1. Write a failing service-level test proving a fetch error becomes a persisted `failed` Link Card rather than deleting/reverting the source URL.
2. Implement `enrich_embed_metadata`: hold no SQLite lock during network I/O, fetch/cache images, then apply one guarded metadata transaction and return the authoritative Embed DTO.
3. Register the command and run `cargo test`.

### Task 5: Drive pending/ready/failed UI states

**Files:**
- Modify: `src/services/workspace-gateway.ts`
- Modify: `src/services/tauri-workspace-gateway.ts`
- Modify: `src/services/mock-workspace-gateway.ts`
- Modify: `src/App.tsx`
- Modify: `src/cards/link/EmbedCard.tsx`
- Test: `src/services/tauri-workspace-gateway.test.ts`
- Test: `src/cards/link/EmbedCard.test.tsx`
- Test: `tests/e2e/canvas-smoke.spec.ts`

1. Write failing tests for the enrichment command mapping, pending skeleton, ready metadata, failure fallback, and Retry.
2. Add `enrichEmbedMetadata({ id, expectedRevision })` to the gateway.
3. Start one deduplicated background enrichment per pending card after conversion or snapshot load; never block note finalization or the global mutation queue on network I/O.
4. Render skeleton fields while pending and a contextual Retry action when failed.
5. Run frontend unit/e2e tests.

### Task 6: Verification and manual Tauri acceptance

**Files:**
- Modify if needed: `docs/specs/link-card-and-clipboard.md`

1. Run `cargo fmt --check`, `cargo test`, `npm run check`, `npm run build`, and `npm run test:e2e`.
2. In `npm run tauri dev`, paste a YouTube video URL and a generic Open Graph URL; verify title, description, favicon, and preview persist after restart.
3. Disable network and verify conversion still leaves an openable failed Link Card with Retry.
4. Do not commit unrelated pre-existing dirty-worktree changes. Commit this slice only after the user confirms the live Tauri acceptance flow.
