-- 0002_assets.sql
-- Asset storage for images and link previews (Image / embed scope).
--
-- Files live as copies under the app's data dir (`assets/<id>.<ext>`); SQLite
-- stores only metadata, never the bytes. `cards.kind` gains 'image' and
-- 'embed'; each has its own detail table keyed by card_id.

-- Independent of cards: the same asset (e.g. a downloaded YouTube preview
-- thumbnail) can back an embed card, and remains valid across board moves.
CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    size_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

-- Image card: a static image plus an editable caption (rich-text, same shape
-- as a note document).
CREATE TABLE image_cards (
    card_id TEXT PRIMARY KEY REFERENCES cards(id),
    asset_id TEXT NOT NULL REFERENCES assets(id),
    caption_json TEXT NOT NULL,
    caption_plain_text TEXT NOT NULL DEFAULT ''
);

-- Embed card: a URL surface with an optional preview image (asset).
CREATE TABLE embed_cards (
    card_id TEXT PRIMARY KEY REFERENCES cards(id),
    url TEXT NOT NULL,
    title TEXT,
    provider TEXT,
    asset_id TEXT REFERENCES assets(id)
);

-- Widen the card kind whitelist. SQLite has no ALTER CHECK, so recreate the
-- table preserving existing rows.
PRAGMA foreign_keys = OFF;

CREATE TABLE cards_new (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id),
    kind TEXT NOT NULL CHECK(kind IN ('note', 'board_portal', 'image', 'embed')),
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL NOT NULL CHECK(width >= 120 AND width <= 1600),
    height REAL NOT NULL CHECK(height >= 48 AND height <= 10000),
    z_index INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    trash_batch_id TEXT
);

INSERT INTO cards_new (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at, deleted_at, trash_batch_id)
SELECT id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at, deleted_at, trash_batch_id FROM cards;

DROP TABLE cards;
ALTER TABLE cards_new RENAME TO cards;

PRAGMA foreign_keys = ON;

CREATE INDEX idx_cards_board_active
    ON cards(board_id, deleted_at, z_index);
CREATE INDEX idx_cards_trash_batch
    ON cards(trash_batch_id);
