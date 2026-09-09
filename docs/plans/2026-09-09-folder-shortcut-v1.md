# Folder Shortcut V1 Implementation Plan

**Goal:** Let the user drag a real macOS folder from Finder onto a Board and receive a resizable, persistent folder shortcut that shows a bounded live preview of top-level names and can open the folder in Finder.

**Architecture:** Add one `filesystem_alias` spatial Card kind backed by opaque macOS bookmark data and a human-readable path hint. Board snapshots carry only persisted alias identity; a separate bounded command resolves bookmarks and reads shallow folder previews so slow or unavailable external storage cannot block SQLite snapshot loading. Reuse the existing Card frame, movement, selection, Search, Trash, Unsorted, and context-menu paths instead of building a parallel canvas object system.

**Tech Stack:** Tauri 2, Rust, `objc2-foundation`/`objc2-app-kit`, SQLite migrations, React 19, React Flow, TypeScript, Vitest, Testing Library, Playwright.

---

## Approved Product Contract

The approved visual reference is:

`/Users/bro/.gstack/projects/MySpace/designs/folder-shortcut-20260909/variant-a-refined.png`

1. Finder folder drop creates a shortcut. The external folder is never copied into `assets/`.
2. The Card has a large, unmistakable blue folder silhouette.
3. File and subfolder rows appear directly on the blue folder surface, not inside a nested white card.
4. Each row shows a type icon, a truncated name, and compact metadata when available.
5. The bottom-right corner resizes width and height using the existing Card resize interaction.
6. Reducing height preserves the folder silhouette and shows fewer rows. Increasing height reveals more rows from the bounded preview.
7. The top-right Finder action opens the linked folder in Finder.
8. A missing or inaccessible folder remains on the Board and shows a clear unavailable state. It is never silently deleted.

## Explicitly Not In Scope

- File/document cards copied into `assets/`.
- `Option`-drop to create file aliases.
- Opening or navigating into child folders inside the Card.
- Recursive listing, filesystem watchers, cached directory snapshots, or child entries persisted as Cards.
- Dragging files out of the shortcut.
- Inline text, Markdown, JSON, CSV, Office, PDF, image, or video previews.
- MCP filesystem reads beyond serializing the alias Card already present in `read_card`.
- App Sandbox or Mac App Store entitlements. V1 remains a signed/notarized direct-download target per ADR-0001.

## Architecture Decisions

### Data Model

Add one Card kind, `filesystem_alias`, and one detail table:

```text
cards
  id, board_id, kind='filesystem_alias', frame, revision,
  unsorted, deleted_at, trash_batch_id, timestamps
       │ 1:1
       ▼
filesystem_aliases
  card_id          FK -> cards.id
  target_kind      'folder' | 'file' (only 'folder' is created in this slice)
  locator_blob     opaque macOS bookmark bytes
  path_hint        last resolved path for display/diagnostics only
  display_name     last resolved folder name
```

Do not persist preview rows. Do not treat `path_hint` as access authority. Rebuild the existing `cards.kind` CHECK once in migration `0012`, preserving every current column including `unsorted`.

### Read Flow

```text
load_board_snapshot(board_id)
  └─ SQLite only -> CardDto::FilesystemAlias(identity + frame)

visible alias Card
  └─ list_folder_preview(card_id, limit)
       ├─ resolve bookmark
       ├─ if stale: refresh bookmark + path_hint transactionally
       ├─ read one directory level
       ├─ scan at most 201 entries
       ├─ directories first, then case-insensitive name
       └─ return at most 50 rows + has_more
```

The UI computes visible rows from the current Card height. It must not issue a new filesystem request on every resize pointer move.

### Failure States

`FolderPreviewStatus` is explicit:

- `ready`: entries are available.
- `empty`: the folder resolves but has no children.
- `missing`: the bookmark no longer resolves to an existing directory.
- `permission_lost`: macOS denies access.
- `io_error`: another bounded read failure occurred.

Every failure keeps the Card visible and movable. `Locate Again` is reserved for the next alias-recovery slice; V1 shows the state and retains the path hint.

### Drop Flow

```text
Finder drag
  -> existing Tauri drag-drop event (paths + position)
  -> Rust path classification (`folder`, `image`, `unsupported`)
  -> folder: create_folder_alias(...)
       -> validate existing directory
       -> create bookmark immediately
       -> insert cards + filesystem_aliases in one DB transaction
  -> image: preserve the existing Image Card path
  -> unsupported file: ignore in this slice without creating a broken Card
```

Tauri's standard drop payload does not contain modifier keys. Do not implement `Option` behavior in this slice and do not infer it from WebView keyboard state.

## Test Coverage Map

```text
CODE PATHS
==========
[Migration 0012]
  ├─ fresh schema contains filesystem_aliases
  ├─ existing Note/Image/Link/Portal rows survive cards rebuild
  ├─ unsorted/deleted/trash/revision fields survive
  └─ foreign_key_check remains clean

[create_folder_alias]
  ├─ valid directory -> bookmark + card + detail row
  ├─ file path -> rejected without partial rows
  ├─ missing path -> rejected without partial rows
  └─ duplicate/replayed card id -> deterministic idempotent result

[list_folder_preview]
  ├─ folders sort before files
  ├─ names sort case-insensitively within kind
  ├─ empty directory -> empty
  ├─ more than 200 children -> bounded scan + has_more
  ├─ missing target -> missing
  └─ permission/read failure -> explicit status

[Board integrations]
  ├─ snapshot and read_card return filesystem_alias
  ├─ move and resize use existing frame mutation
  ├─ Search finds display_name and path_hint
  ├─ Trash/restore keeps bookmark detail row
  └─ Unsorted renders the same alias identity

USER FLOWS
==========
[E2E browser/mock]
  ├─ folder Card renders approved silhouette and rows
  ├─ bottom-right resize persists dimensions
  ├─ smaller height reveals fewer rows without clipping title/actions
  ├─ context delete -> Trash -> restore
  └─ Search result navigates to and highlights/selects the Card

[Packaged macOS acceptance]
  ├─ drop a real external folder from Finder
  ├─ restart the packaged app
  ├─ folder still resolves and lists current top-level names
  ├─ rename/move folder and verify bookmark resolution behavior
  └─ Finder action opens the linked folder
```

## Task 1: Add the Alias Schema and Domain DTOs

**Files:**
- Create: `src-tauri/migrations/0012_filesystem_aliases.sql`
- Modify: `src-tauri/src/db/migrations.rs`
- Modify: `src-tauri/src/domain/models.rs`
- Test: `src-tauri/tests/migrations.rs`

1. Write failing migration tests for the new table, allowed Card kind, preservation of all current Card columns/data, and `PRAGMA foreign_key_check`.
2. Run `cargo test --manifest-path src-tauri/Cargo.toml --test migrations` and confirm RED.
3. Add migration `0012` and register it append-only.
4. Add `FilesystemAliasDto`, `FolderEntryDto`, `FolderPreviewDto`, and explicit status enums.
5. Run the focused migration tests and confirm GREEN.
6. Commit: `feat: add filesystem alias persistence model`.

## Task 2: Add the macOS Bookmark Boundary and Folder Service

**Files:**
- Create: `src-tauri/src/domain/filesystem_alias_service.rs`
- Modify: `src-tauri/src/domain/mod.rs`
- Modify: `src-tauri/Cargo.toml` only if explicit `objc2` feature flags are required
- Test: `src-tauri/tests/filesystem_alias_service.rs`

1. Write failing tests around a narrow locator interface, using a fake locator for cross-platform service tests.
2. Cover valid directory creation, file/missing rejection, no partial rows, stale locator refresh, empty directory, deterministic sorting, bounded reads, and all failure statuses.
3. Run the focused test and confirm RED.
4. Implement the service with an opaque `FolderLocator` boundary. Keep Objective-C calls in a macOS-only module and provide an explicit unsupported-platform implementation.
5. Use bookmark bytes as authority; `path_hint` is never used as silent fallback after bookmark resolution fails.
6. Run focused tests and confirm GREEN.
7. Commit: `feat: add durable macOS folder locators`.

## Task 3: Expose Commands and Repository Projections

**Files:**
- Create: `src-tauri/src/commands/filesystem_aliases.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/repositories/workspace_repository.rs`
- Modify: `src-tauri/src/services/workspace_service.rs`
- Modify: `src-tauri/src/bin/myspace-mcp.rs`
- Test: `src-tauri/tests/workspace_repository.rs`
- Test: `src-tauri/tests/filesystem_alias_service.rs`

1. Write failing tests for snapshot/read-card mapping, creation command inputs, preview output, and serialized Card shape.
2. Run focused tests and confirm RED.
3. Add `create_folder_alias`, `list_folder_preview`, `classify_drop_paths`, and `open_folder_in_finder` commands.
4. Resolve and open the bookmark entirely in Rust. Do not pass a resolved authority path back to JavaScript.
5. Update exhaustive `CardDto` matches, including MCP revision extraction, without adding arbitrary filesystem reads to MCP.
6. Run focused Rust tests and confirm GREEN.
7. Commit: `feat: expose folder shortcut commands`.

## Task 4: Extend Gateway and Mock Contracts

**Files:**
- Modify: `src/services/workspace-gateway.ts`
- Modify: `src/services/tauri-workspace-gateway.ts`
- Modify: `src/services/mock-workspace-gateway.ts`
- Test: `src/services/tauri-workspace-gateway.test.ts`
- Test: `src/services/mock-workspace-gateway.test.ts`

1. Write failing adapter and mock behavior tests.
2. Run `npm test -- src/services/tauri-workspace-gateway.test.ts src/services/mock-workspace-gateway.test.ts` and confirm RED.
3. Add typed DTOs and methods matching the Rust camelCase contract.
4. Make the mock expose deterministic ready, empty, missing, and error previews.
5. Run focused tests and confirm GREEN.
6. Commit: `feat: add folder shortcut gateway contract`.

## Task 5: Generalize Native Drop Classification

**Files:**
- Modify: `src/services/drag-drop.ts`
- Modify: `src/App.tsx`
- Test: `src/services/drag-drop.test.ts`
- Test: `src/App.test.tsx` if an App integration test already exists; otherwise cover orchestration through the nearest established boundary

1. Write failing tests proving that folder paths reach classification while existing image drops still create Image Cards.
2. Run focused tests and confirm RED.
3. Rename the image-only subscription boundary to a generic native-drop subscription without changing the Tauri event source.
4. Classify paths in Rust. Route `folder` to `createFolderAlias`, `image` to the existing image import, and `unsupported` to no creation.
5. Place multiple dropped items with a small deterministic offset so they do not fully overlap.
6. Run focused tests and confirm GREEN.
7. Commit: `feat: create folder shortcuts from Finder drops`.

## Task 6: Build the Approved Resizable Folder Card

**Files:**
- Create: `src/cards/folder/FolderShortcutCard.tsx`
- Create: `src/cards/folder/folder-shortcut-card.css`
- Create: `src/cards/folder/FolderShortcutCard.test.tsx`
- Modify: `src/cards/card-registry.tsx`
- Modify: `src/App.tsx`

1. Write failing component tests for the approved silhouette, direct-on-blue rows, long-name truncation, ready/empty/error states, Finder action, and bottom-right resize.
2. Run the focused component test and confirm RED.
3. Implement the Card using semantic design tokens. Do not nest a white Card inside the folder.
4. Use the existing resize gesture and `moveCard` persistence path. Minimum size: `280x180`; maximum remains the domain frame maximum.
5. Derive visible row count from committed/draft height, with at least two rows when available. Never refetch during pointer movement.
6. Add loading and unavailable states that keep title, path hint, Finder action, and resize handle coherent.
7. Run focused tests and confirm GREEN.
8. Commit: `feat: render resizable live folder shortcuts`.

## Task 7: Complete Search, Trash, Unsorted, and Context Integrations

**Files:**
- Modify: `src-tauri/src/repositories/workspace_repository.rs`
- Modify: `src-tauri/src/domain/trash_service.rs` only where kind-specific summarization requires it
- Modify: `src/services/mock-workspace-gateway.ts`
- Modify: `src/navigation/UnsortedPanel.tsx`
- Modify: `src/components/context-menu/ContextMenu.tsx`
- Modify: `src/App.tsx`
- Test: corresponding existing Rust and React test files

1. Write failing tests for Search by display name/path hint, Trash batch title/kind, restore, Unsorted preview, and Show in Finder.
2. Run focused tests and confirm RED.
3. Add alias branches to every exhaustive Card-kind boundary found by `rg "CardDto::|card.kind|switch.*kind"`.
4. Preserve generic move/resize/delete behavior instead of duplicating commands.
5. Run focused tests and confirm GREEN.
6. Commit: `feat: integrate folder shortcuts across workspace surfaces`.

## Task 8: Acceptance and Regression Gate

**Files:**
- Create: `tests/e2e/folder-shortcut.spec.ts`
- Create: `docs/testing/folder-shortcut-manual.md`
- Modify: `tasks/todo.md`

1. Add browser/mock E2E coverage for rendering, resize, Search, Trash/restore, and Unsorted.
2. Document the real packaged macOS Finder-drop/restart/move/open acceptance procedure.
3. Run:

```bash
npm run check
npm run build
npm run test:e2e
cargo test --manifest-path src-tauri/Cargo.toml
```

4. Build a packaged macOS app and execute the manual acceptance procedure. `tauri dev` alone is not proof of bookmark durability.
5. Compare the rendered Card with the approved PNG at normal size and the minimum size. Reject nested white surfaces, clipped names/actions, or a lost folder silhouette.
6. Update `tasks/todo.md` only after all gates pass.
7. Commit: `test: verify folder shortcut lifecycle`.

## Failure Modes

| Failure | Test | Handling | User-visible result |
|---|---|---|---|
| Dropped path is a file | Rust service test | Reject before DB write | Existing image path or no Card for unsupported files |
| Bookmark cannot resolve after restart | Packaged acceptance + fake locator test | Keep Card | `Missing`/unavailable state |
| Permission denied | Fake locator test | Keep Card | `Permission lost` state |
| Huge directory | Bounded listing test | Stop after 201 scanned entries | First rows plus `More items` |
| Folder renamed or moved | Packaged acceptance | Refresh stale bookmark/path hint | Card continues with updated identity where macOS resolves it |
| DB insert fails after locator creation | Repository test | Transaction rollback | No partial Card/detail row |
| Resize interrupted | Component test | Persist only on completed pointer-up | Last committed size remains |
| Filesystem read is slow | Architecture boundary | Snapshot never waits for preview | Card shows loading while canvas remains usable |

## Parallelization

Sequential implementation is recommended. Tasks 1-3 define the DTO and command contract consumed by Tasks 4-7, while Tasks 5-7 all touch `App.tsx` and would create avoidable merge conflicts.
