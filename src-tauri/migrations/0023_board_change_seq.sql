-- 0023_board_change_seq.sql
-- Targeted invalidation (P1.6): `boards.change_seq` is a per-board counter
-- bumped whenever something the board's snapshot renders changes, so the UI
-- reloads only the board that an external writer (the MCP server, a second
-- app instance, later a sync journal replay) actually touched.
--
-- Like `search_index` (0022), it is maintained ONLY by the triggers below,
-- never by Rust mutation code, so every writer bumps it identically. The value
-- is local bookkeeping and is never synced.
--
-- What bumps a board's `change_seq`:
--   cards               INSERT / UPDATE / DELETE: the card's board; on a move
--                       (board_id changed) the old board too. When the card
--                       appears or disappears from a board (insert, delete,
--                       deleted_at or board_id change) the board's PARENT is
--                       bumped as well: its portal tile shows child_card_count.
--   detail tables       INSERT / UPDATE / DELETE on note_cards, image_cards,
--                       embed_cards, file_cards, filesystem_aliases,
--                       board_portal_cards, board_shortcut_cards: the owning
--                       card's board, resolved through `cards` (a no-op if the
--                       card row is already gone; the `cards` trigger covers it).
--   boards              UPDATE of title, color_token, symbol, cover_asset_id,
--                       deleted_at or parent_board_id (value actually changed):
--                       the board itself, its old and new parent (portal tile
--                       title/cover/child_board_count) and every board holding
--                       a shortcut card that points at it (shortcut tiles show
--                       the target's title/color/cover).
--
-- What does NOT bump: `board_view_states` (viewport is own-device UI state),
-- `quick_boards`, receipts, assets, search_index.
--
-- No recursion: the boards trigger is `AFTER UPDATE OF <rendered columns>`,
-- and the bump itself only sets `change_seq`, which is not in that list (and
-- recursive_triggers is off). Every trigger is AFTER and touches boards rows by
-- primary key.

ALTER TABLE boards ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;

-- cards ------------------------------------------------------------------------

CREATE TRIGGER change_seq_cards_ai AFTER INSERT ON cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = NEW.board_id
       OR id = (SELECT parent_board_id FROM boards WHERE id = NEW.board_id);
END;

CREATE TRIGGER change_seq_cards_au AFTER UPDATE ON cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id IN (OLD.board_id, NEW.board_id);
END;

CREATE TRIGGER change_seq_cards_au_count AFTER UPDATE OF board_id, deleted_at ON cards
WHEN OLD.board_id IS NOT NEW.board_id OR OLD.deleted_at IS NOT NEW.deleted_at BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id IN (
        SELECT parent_board_id FROM boards WHERE id IN (OLD.board_id, NEW.board_id)
    );
END;

CREATE TRIGGER change_seq_cards_ad AFTER DELETE ON cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = OLD.board_id
       OR id = (SELECT parent_board_id FROM boards WHERE id = OLD.board_id);
END;

-- boards -----------------------------------------------------------------------

CREATE TRIGGER change_seq_boards_au
AFTER UPDATE OF title, color_token, symbol, cover_asset_id, deleted_at, parent_board_id ON boards
WHEN OLD.title IS NOT NEW.title
  OR OLD.color_token IS NOT NEW.color_token
  OR OLD.symbol IS NOT NEW.symbol
  OR OLD.cover_asset_id IS NOT NEW.cover_asset_id
  OR OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.parent_board_id IS NOT NEW.parent_board_id
BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id IN (NEW.id, OLD.parent_board_id, NEW.parent_board_id);
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id IN (
        SELECT c.board_id FROM board_shortcut_cards s
        JOIN cards c ON c.id = s.card_id
        WHERE s.target_board_id = NEW.id
    );
END;

-- detail tables ----------------------------------------------------------------

-- note_cards

CREATE TRIGGER change_seq_note_cards_ai AFTER INSERT ON note_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = NEW.card_id);
END;

CREATE TRIGGER change_seq_note_cards_au AFTER UPDATE ON note_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = NEW.card_id);
END;

CREATE TRIGGER change_seq_note_cards_ad AFTER DELETE ON note_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = OLD.card_id);
END;

-- image_cards

CREATE TRIGGER change_seq_image_cards_ai AFTER INSERT ON image_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = NEW.card_id);
END;

CREATE TRIGGER change_seq_image_cards_au AFTER UPDATE ON image_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = NEW.card_id);
END;

CREATE TRIGGER change_seq_image_cards_ad AFTER DELETE ON image_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = OLD.card_id);
END;

-- embed_cards

CREATE TRIGGER change_seq_embed_cards_ai AFTER INSERT ON embed_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = NEW.card_id);
END;

CREATE TRIGGER change_seq_embed_cards_au AFTER UPDATE ON embed_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = NEW.card_id);
END;

CREATE TRIGGER change_seq_embed_cards_ad AFTER DELETE ON embed_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = OLD.card_id);
END;

-- file_cards

CREATE TRIGGER change_seq_file_cards_ai AFTER INSERT ON file_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = NEW.card_id);
END;

CREATE TRIGGER change_seq_file_cards_au AFTER UPDATE ON file_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = NEW.card_id);
END;

CREATE TRIGGER change_seq_file_cards_ad AFTER DELETE ON file_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = OLD.card_id);
END;

-- filesystem_aliases

CREATE TRIGGER change_seq_filesystem_aliases_ai AFTER INSERT ON filesystem_aliases BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = NEW.card_id);
END;

CREATE TRIGGER change_seq_filesystem_aliases_au AFTER UPDATE ON filesystem_aliases BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = NEW.card_id);
END;

CREATE TRIGGER change_seq_filesystem_aliases_ad AFTER DELETE ON filesystem_aliases BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = OLD.card_id);
END;

-- board_portal_cards

CREATE TRIGGER change_seq_board_portal_cards_ai AFTER INSERT ON board_portal_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = NEW.card_id);
END;

CREATE TRIGGER change_seq_board_portal_cards_au AFTER UPDATE ON board_portal_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = NEW.card_id);
END;

CREATE TRIGGER change_seq_board_portal_cards_ad AFTER DELETE ON board_portal_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = OLD.card_id);
END;

-- board_shortcut_cards

CREATE TRIGGER change_seq_board_shortcut_cards_ai AFTER INSERT ON board_shortcut_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = NEW.card_id);
END;

CREATE TRIGGER change_seq_board_shortcut_cards_au AFTER UPDATE ON board_shortcut_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = NEW.card_id);
END;

CREATE TRIGGER change_seq_board_shortcut_cards_ad AFTER DELETE ON board_shortcut_cards BEGIN
    UPDATE boards SET change_seq = change_seq + 1
    WHERE id = (SELECT board_id FROM cards WHERE id = OLD.card_id);
END;
