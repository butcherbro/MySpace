-- 0021_cards_drop_kind_check.sql
-- The LAST `cards` rebuild (P1.3, audit finding K3). The card kind and the
-- frame size bounds move from SQL CHECK constraints to Rust:
--   * kind:  `domain::card_kind::CardKind` (`FromStr`, `is_valid`), one
--            handler per kind in `domain::kinds`;
--   * frame: `Frame::validate` (width 120..=1600, height 48..=10000, finite
--            x/y), called by every create/move/resize repository function.
-- Adding a card kind from now on is a new detail table plus a handler, never
-- another create-copy-drop-rename of `cards`.
--
-- Same pattern as 0018_board_shortcuts.sql: every other column, default,
-- CHECK and foreign key is kept exactly; rows are copied verbatim; every index
-- that existed on `cards` (0018's two plus 0019's partial `idx_cards_trashed`)
-- is recreated. The migration runner disables foreign keys around this file
-- and runs `PRAGMA foreign_key_check` + `quick_check` afterwards.

CREATE TABLE cards_new (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id),
    kind TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL NOT NULL,
    height REAL NOT NULL,
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
CREATE INDEX idx_cards_trashed ON cards(deleted_at) WHERE deleted_at IS NOT NULL;
