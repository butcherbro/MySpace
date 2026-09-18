-- 0018_board_shortcuts.sql
-- Board shortcuts (todo.md №17): a lightweight alias card that points at a
-- board without owning it (ownership stays with `board_portal_cards`). A
-- board may have any number of shortcuts pointing at it; deleting a shortcut
-- never touches the target board, and trashing the target board (or an
-- ancestor) cascades to every shortcut pointing into that subtree
-- (see trash_service::trash_board_in_tx).

CREATE TABLE board_shortcut_cards (
    card_id TEXT PRIMARY KEY REFERENCES cards(id),
    target_board_id TEXT NOT NULL REFERENCES boards(id)
);

CREATE INDEX idx_board_shortcut_cards_target ON board_shortcut_cards(target_board_id);

-- Rebuild cards to widen the kind CHECK to include 'board_shortcut', preserving
-- every current column and existing kind (same pattern as 0013_file_cards.sql).
CREATE TABLE cards_new (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id),
    kind TEXT NOT NULL CHECK(kind IN ('note', 'board_portal', 'image', 'embed', 'filesystem_alias', 'file', 'board_shortcut')),
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
