-- 0012_filesystem_aliases.sql
-- Folder shortcuts: a `filesystem_alias` card kind referencing an opaque macOS
-- bookmark (authority for access) plus a human-readable path/name hint. The
-- external folder is never copied into assets/.

CREATE TABLE filesystem_aliases (
    card_id TEXT PRIMARY KEY REFERENCES cards(id),
    target_kind TEXT NOT NULL CHECK(target_kind IN ('folder', 'file')),
    locator_blob BLOB NOT NULL,
    path_hint TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT ''
);

-- Rebuild cards to widen the kind CHECK to include 'filesystem_alias',
-- preserving every current column including `unsorted` (migration 0010).
CREATE TABLE cards_new (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id),
    kind TEXT NOT NULL CHECK(kind IN ('note', 'board_portal', 'image', 'embed', 'filesystem_alias')),
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL NOT NULL CHECK(width >= 120 AND width <= 1600),
    height REAL NOT NULL CHECK(height >= 48 AND height <= 10000),
    z_index INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    trash_batch_id TEXT,
    unsorted INTEGER NOT NULL DEFAULT 0 CHECK(unsorted IN (0, 1))
);

INSERT INTO cards_new (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at, deleted_at, trash_batch_id, unsorted)
SELECT id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at, deleted_at, trash_batch_id, unsorted FROM cards;

DROP TABLE cards;
ALTER TABLE cards_new RENAME TO cards;

CREATE INDEX idx_cards_board_active ON cards(board_id, deleted_at, z_index);
CREATE INDEX idx_cards_trash_batch ON cards(trash_batch_id);
