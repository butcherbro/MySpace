-- 0027_connectors.sql
-- Connectors: arrows between two cards of the same board (Milanote-style).
--
-- A connector is its own synced entity (journal kind `connector`, registers
-- `body` and `life` like a card), not a card: it has no frame and is drawn
-- between its endpoints.
-- `board_id` is the board both endpoints sit on; the snapshot only shows a
-- connector while both endpoints are live canvas cards of that board.
--
-- Trash follows the endpoints: trashing a card soft-deletes its connectors
-- with the same `trash_batch_id`, restoring the batch restores them. Every
-- removal is a soft delete; a row is physically removed only by the cascade
-- below when Empty Trash (or a replayed purge) deletes an endpoint or board.
--
-- Почему CASCADE: жёсткое удаление карточки или доски (Empty Trash, purge из
-- реплея) не должно ни падать на FK, ни оставлять висячую стрелку. DELETE-
-- триггеры срабатывают и на каскаде, поэтому журнал всё равно получает
-- `present: false`, а `change_seq` доски растёт.
--
-- `color_token` uses the note color presets; `arrow_ends` is where the
-- arrowheads are drawn. `label` is stored but not editable yet.

CREATE TABLE connectors (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    from_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    to_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    color_token TEXT NOT NULL DEFAULT 'default'
        CHECK(color_token IN ('default', 'yellow', 'pink', 'lavender', 'blue', 'green', 'gray')),
    arrow_ends TEXT NOT NULL DEFAULT 'end' CHECK(arrow_ends IN ('end', 'both', 'none')),
    label TEXT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER NULL,
    trash_batch_id TEXT NULL
);

CREATE INDEX idx_connectors_board ON connectors(board_id);
CREATE INDEX idx_connectors_from_card ON connectors(from_card_id);
CREATE INDEX idx_connectors_to_card ON connectors(to_card_id);
CREATE INDEX idx_connectors_trash_batch ON connectors(trash_batch_id);

-- change_seq (0023): a connector change re-renders its board.

CREATE TRIGGER change_seq_connectors_ai AFTER INSERT ON connectors BEGIN
    UPDATE boards SET change_seq = change_seq + 1 WHERE id = NEW.board_id;
END;

CREATE TRIGGER change_seq_connectors_au AFTER UPDATE ON connectors BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id IN (OLD.board_id, NEW.board_id);
END;

CREATE TRIGGER change_seq_connectors_ad AFTER DELETE ON connectors BEGIN
    UPDATE boards SET change_seq = change_seq + 1 WHERE id = OLD.board_id;
END;
