# File Cards V1 Implementation Plan

**Goal:** Let the user drag a text-like file (txt, md, json, csv) from Finder onto a
Board and receive a persistent File Card: the file is copied into the managed asset
store, the card shows a readable inline preview of the text, and an "open" action
launches the file in its default external app.

**Architecture:** one new Card kind `file` plus a `file_cards` detail table referencing
the copied asset. Preview text (bounded) is stored on the row so snapshots never read
from disk. Reuses existing Card frame/move/resize/selection/Search/Trash/Unsorted and
the managed-asset copy-in model.

**Tech Stack:** Tauri 2, Rust, SQLite migrations, React 19, React Flow, TypeScript,
Vitest, Playwright.

---

## Approved Product Contract (V1)

1. Dragging a **text-like** file (`.txt`, `.md`, `.json`, `.csv`) from Finder onto a
   Board creates a File Card. The file is **copied** into `assets/` (never referenced
   in place).
2. The card shows a large file-type icon, the file name, size, and a readable inline
   preview of the text content (bounded, e.g. first 8 KB, trimmed).
3. The top-right action opens the stored file in its default external app (macOS
   `open`).
4. Non-text files (e.g. `.docx`, `.xlsx`, `.pdf`, `.zip`) are **not** created in this
   slice: their drop is ignored (no broken card).
5. Image files keep the existing Image Card path (unchanged).
6. Folders keep the existing Folder Shortcut path (unchanged).
7. The card participates in move/resize/selection, Search (by file name), Trash/restore,
   and Unsorted like any other card.

## Explicitly Not In Scope (V1)

- Rich previews for Office/PDF/ZIP (icon + open only, and even that is deferred: in V1
  those files are not created at all).
- `⌥`-drop to create a file alias instead of a copy.
- Editing file content in place.
- Recursive listing, watchers, or other filesystem features.
- App Sandbox entitlements.

## Data Model

Add one Card kind, `file`, and one detail table:

```text
cards
  id, board_id, kind='file', frame, revision, unsorted, deleted_at, trash_batch_id
       │ 1:1
       ▼
file_cards
  card_id       FK -> cards.id
  asset_id      FK -> assets.id
  mime_type     text (for icon/type classification)
  preview_text  bounded inline preview (empty for non-text in future slices)
```

Rebuild the `cards.kind` CHECK once in migration `0013` (append `file`), preserving all
columns including `unsorted`.

## Read Flow

```text
load_board_snapshot(board_id)
  └─ SQLite only -> CardDto::FileCard(file identity + frame + preview_text)
```

Preview text is stored on the row; no filesystem read during snapshot.

## Drop Flow

```text
Finder drag
  -> classify_drop_paths: 'folder' | 'image' | 'text_file' | 'unsupported'
  -> text_file: create_file_card(...)
       -> validate file + bounded read of preview
       -> copy file into assets/ under a UUID
       -> insert cards + file_cards in one transaction
  -> folder: existing folder shortcut path
  -> image: existing image card path
  -> unsupported: no creation
```

`classify_drop_paths` (in the filesystem alias service) is extended to return
`text_file` for `.txt/.md/.json/.csv` and `unsupported` for other non-image files.

## Test Coverage Map

- Migration 0013: `file` kind accepted; `file_cards` table exists; existing
  Note/Image/Embed/Portal/Alias rows + unsorted/deleted/trash/revision survive;
  `foreign_key_check` clean.
- create_file_card: valid text file -> asset copy + card + detail row; non-text path
  rejected with no partial rows; missing path rejected; idempotent replay by card id.
- classify_drop_paths: txt/md/json/csv -> text_file; docx/xlsx/pdf -> unsupported;
  image extensions unchanged.
- Board integrations: snapshot/read_card return file card; move/resize reuse frame
  mutation; Search finds file name; Trash/restore keeps detail row; Unsorted renders
  the file card identity.
- E2E (browser/mock): file card renders with preview + open action; resize persists;
  Search -> navigate; delete -> Trash -> restore.
- Packaged macOS acceptance (manual): real Finder drop of a .txt, restart, file card
  persists and preview remains; "open" launches the default app.

## Tasks

1. Migration `0013` + DTOs (`FileCardDto`, `CreateFileCardInput`) + tests.
2. Asset import for text files (copy with original extension, bounded preview read).
3. `create_file_card` command + repository insert; `classify_drop_paths` returns
   `text_file`; `read_card`/snapshot mapping.
4. Gateway + mock + drag-drop route for `text_file`.
5. `FileCard` React component (icon, name, size, preview, open, resize).
6. Integrations: Search, Trash, Unsorted, context menu (open).
7. E2E + manual docs + full gate.

## Ordering

Sequential recommended; tasks 1–3 define the contract consumed by 4–7, and 5–7 touch
the same frontend files as the folder shortcut did.
