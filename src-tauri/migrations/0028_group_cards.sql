-- 0028_group_cards.sql
-- Canvas groups (ADR-0013): a named, coloured frame drawn under other cards.
--
-- A group is an ordinary card of kind `group` (no `cards` change: migration
-- 0021 dropped the kind CHECK). Membership is NOT stored: a card belongs to a
-- group while its frame lies inside the group frame, computed by the frontend.
-- The title is stored as given; `''` is an untitled group and the frontend
-- renders the localized fallback. `color_token` uses the note color presets.
-- Not searchable in v1: no search_index triggers.

CREATE TABLE group_cards (
    card_id     TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT '',
    color_token TEXT NOT NULL DEFAULT 'default'
        CHECK (color_token IN ('default', 'yellow', 'pink', 'lavender', 'blue', 'green', 'gray'))
);

-- change_seq (0023): a group's title or color re-renders its board.

CREATE TRIGGER change_seq_group_cards_ai AFTER INSERT ON group_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = NEW.card_id);
END;

CREATE TRIGGER change_seq_group_cards_au AFTER UPDATE ON group_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = NEW.card_id);
END;

CREATE TRIGGER change_seq_group_cards_ad AFTER DELETE ON group_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = OLD.card_id);
END;
