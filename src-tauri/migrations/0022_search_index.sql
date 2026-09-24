-- 0022_search_index.sql
-- Full-text search index (P1.4, audit finding M-2 / Q3).
--
-- `search_index` is DERIVED data. It is maintained only by the triggers below,
-- never by Rust mutation code, so writes from the UI, the MCP process and a
-- future journal replay all index identically. It is never synced: a replica
-- rebuilds it from its own rows.
--
-- Columns:
--   entity_id  board id or card id (UNINDEXED)
--   kind       'board' or the card kind as stored in `cards.kind` (UNINDEXED)
--   board_id   the board the entity lives on; a board's own id for boards
--              (UNINDEXED, informational — the query reads the live value)
--   title      title-level text (ranked before body matches)
--   body       everything else searchable
--
-- What is indexed:
--   boards              title                      -> title
--   note_cards          plain_text                 -> body
--   embed_cards         title, source_url,
--                       display_url                -> title
--                       description_plain_text     -> body
--   image_cards         caption_plain_text + asset file_name -> body
--   file_cards          asset file_name            -> title
--                       preview_text               -> body
--   filesystem_aliases  display_name               -> title
--                       path_hint                  -> body
--   board_portal_cards / board_shortcut_cards: nothing of their own (the
--   target board is indexed as a board).
--
-- Soft delete (trash) is NOT mirrored here: trashed rows stay indexed and the
-- query excludes them by joining `cards.deleted_at IS NULL` and
-- `boards.deleted_at IS NULL`. That keeps trash/restore free of index work.
-- Rows leave the index only when the detail/board row is hard-deleted
-- (empty trash).
--
-- FTS5 rowids: `entity_id` is UNINDEXED, so `WHERE entity_id = ?` on the FTS
-- table would scan it. `search_index_keys` gives every entity a stable
-- INTEGER PRIMARY KEY (unchanged by VACUUM) that is used as the FTS rowid, so
-- every trigger touches exactly one FTS row by rowid. Keys are namespaced
-- ('b:' || board id, 'c:' || card id) so a board and a card can never share
-- one.
--
-- Insert triggers delete-then-insert: `INSERT OR REPLACE` on a detail table
-- (journal codec) does not fire DELETE triggers unless recursive_triggers is
-- on, so the insert path must itself replace a stale index row.

CREATE VIRTUAL TABLE search_index USING fts5(
    entity_id UNINDEXED,
    kind UNINDEXED,
    board_id UNINDEXED,
    title,
    body,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE search_index_keys (
    id INTEGER PRIMARY KEY,
    entity_key TEXT NOT NULL UNIQUE
);

-- boards ---------------------------------------------------------------------

CREATE TRIGGER search_boards_ai AFTER INSERT ON boards BEGIN
    INSERT OR IGNORE INTO search_index_keys (entity_key) VALUES ('b:' || NEW.id);
    DELETE FROM search_index WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'b:' || NEW.id);
    INSERT INTO search_index (rowid, entity_id, kind, board_id, title, body)
    SELECT k.id, NEW.id, 'board', NEW.id, NEW.title, ''
    FROM search_index_keys k WHERE k.entity_key = 'b:' || NEW.id;
END;

CREATE TRIGGER search_boards_au AFTER UPDATE OF title ON boards BEGIN
    UPDATE search_index SET title = NEW.title
    WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'b:' || NEW.id);
END;

CREATE TRIGGER search_boards_ad AFTER DELETE ON boards BEGIN
    DELETE FROM search_index WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'b:' || OLD.id);
    DELETE FROM search_index_keys WHERE entity_key = 'b:' || OLD.id;
END;

-- cards: keep the informational board_id in step with moves ------------------

CREATE TRIGGER search_cards_move AFTER UPDATE OF board_id ON cards BEGIN
    UPDATE search_index SET board_id = NEW.board_id
    WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'c:' || NEW.id);
END;

-- note_cards -------------------------------------------------------------------

CREATE TRIGGER search_note_ai AFTER INSERT ON note_cards BEGIN
    INSERT OR IGNORE INTO search_index_keys (entity_key) VALUES ('c:' || NEW.card_id);
    DELETE FROM search_index WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'c:' || NEW.card_id);
    INSERT INTO search_index (rowid, entity_id, kind, board_id, title, body)
    SELECT k.id, NEW.card_id, 'note', (SELECT board_id FROM cards WHERE id = NEW.card_id), '', NEW.plain_text
    FROM search_index_keys k WHERE k.entity_key = 'c:' || NEW.card_id;
END;

CREATE TRIGGER search_note_au AFTER UPDATE OF plain_text ON note_cards BEGIN
    UPDATE search_index SET body = NEW.plain_text
    WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'c:' || NEW.card_id);
END;

CREATE TRIGGER search_note_ad AFTER DELETE ON note_cards BEGIN
    DELETE FROM search_index WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'c:' || OLD.card_id);
    DELETE FROM search_index_keys WHERE entity_key = 'c:' || OLD.card_id;
END;

-- embed_cards ------------------------------------------------------------------

CREATE TRIGGER search_embed_ai AFTER INSERT ON embed_cards BEGIN
    INSERT OR IGNORE INTO search_index_keys (entity_key) VALUES ('c:' || NEW.card_id);
    DELETE FROM search_index WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'c:' || NEW.card_id);
    INSERT INTO search_index (rowid, entity_id, kind, board_id, title, body)
    SELECT k.id, NEW.card_id, 'embed', (SELECT board_id FROM cards WHERE id = NEW.card_id),
           COALESCE(NEW.title, '') || ' ' || NEW.source_url || ' ' || NEW.display_url,
           NEW.description_plain_text
    FROM search_index_keys k WHERE k.entity_key = 'c:' || NEW.card_id;
END;

CREATE TRIGGER search_embed_au
AFTER UPDATE OF title, source_url, display_url, description_plain_text ON embed_cards BEGIN
    UPDATE search_index
    SET title = COALESCE(NEW.title, '') || ' ' || NEW.source_url || ' ' || NEW.display_url,
        body = NEW.description_plain_text
    WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'c:' || NEW.card_id);
END;

CREATE TRIGGER search_embed_ad AFTER DELETE ON embed_cards BEGIN
    DELETE FROM search_index WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'c:' || OLD.card_id);
    DELETE FROM search_index_keys WHERE entity_key = 'c:' || OLD.card_id;
END;

-- image_cards ------------------------------------------------------------------

CREATE TRIGGER search_image_ai AFTER INSERT ON image_cards BEGIN
    INSERT OR IGNORE INTO search_index_keys (entity_key) VALUES ('c:' || NEW.card_id);
    DELETE FROM search_index WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'c:' || NEW.card_id);
    INSERT INTO search_index (rowid, entity_id, kind, board_id, title, body)
    SELECT k.id, NEW.card_id, 'image', (SELECT board_id FROM cards WHERE id = NEW.card_id), '',
           NEW.caption_plain_text || ' ' || COALESCE((SELECT file_name FROM assets WHERE id = NEW.asset_id), '')
    FROM search_index_keys k WHERE k.entity_key = 'c:' || NEW.card_id;
END;

CREATE TRIGGER search_image_au AFTER UPDATE OF caption_plain_text, asset_id ON image_cards BEGIN
    UPDATE search_index
    SET body = NEW.caption_plain_text || ' ' || COALESCE((SELECT file_name FROM assets WHERE id = NEW.asset_id), '')
    WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'c:' || NEW.card_id);
END;

CREATE TRIGGER search_image_ad AFTER DELETE ON image_cards BEGIN
    DELETE FROM search_index WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'c:' || OLD.card_id);
    DELETE FROM search_index_keys WHERE entity_key = 'c:' || OLD.card_id;
END;

-- file_cards -------------------------------------------------------------------

CREATE TRIGGER search_file_ai AFTER INSERT ON file_cards BEGIN
    INSERT OR IGNORE INTO search_index_keys (entity_key) VALUES ('c:' || NEW.card_id);
    DELETE FROM search_index WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'c:' || NEW.card_id);
    INSERT INTO search_index (rowid, entity_id, kind, board_id, title, body)
    SELECT k.id, NEW.card_id, 'file', (SELECT board_id FROM cards WHERE id = NEW.card_id),
           COALESCE((SELECT file_name FROM assets WHERE id = NEW.asset_id), ''), NEW.preview_text
    FROM search_index_keys k WHERE k.entity_key = 'c:' || NEW.card_id;
END;

CREATE TRIGGER search_file_au AFTER UPDATE OF asset_id, preview_text ON file_cards BEGIN
    UPDATE search_index
    SET title = COALESCE((SELECT file_name FROM assets WHERE id = NEW.asset_id), ''),
        body = NEW.preview_text
    WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'c:' || NEW.card_id);
END;

CREATE TRIGGER search_file_ad AFTER DELETE ON file_cards BEGIN
    DELETE FROM search_index WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'c:' || OLD.card_id);
    DELETE FROM search_index_keys WHERE entity_key = 'c:' || OLD.card_id;
END;

-- filesystem_aliases -----------------------------------------------------------

CREATE TRIGGER search_alias_ai AFTER INSERT ON filesystem_aliases BEGIN
    INSERT OR IGNORE INTO search_index_keys (entity_key) VALUES ('c:' || NEW.card_id);
    DELETE FROM search_index WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'c:' || NEW.card_id);
    INSERT INTO search_index (rowid, entity_id, kind, board_id, title, body)
    SELECT k.id, NEW.card_id, 'filesystem_alias', (SELECT board_id FROM cards WHERE id = NEW.card_id),
           NEW.display_name, NEW.path_hint
    FROM search_index_keys k WHERE k.entity_key = 'c:' || NEW.card_id;
END;

CREATE TRIGGER search_alias_au AFTER UPDATE OF display_name, path_hint ON filesystem_aliases BEGIN
    UPDATE search_index SET title = NEW.display_name, body = NEW.path_hint
    WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'c:' || NEW.card_id);
END;

CREATE TRIGGER search_alias_ad AFTER DELETE ON filesystem_aliases BEGIN
    DELETE FROM search_index WHERE rowid = (SELECT id FROM search_index_keys WHERE entity_key = 'c:' || OLD.card_id);
    DELETE FROM search_index_keys WHERE entity_key = 'c:' || OLD.card_id;
END;

-- Backfill from existing rows (trashed ones included; see above) --------------

INSERT INTO search_index_keys (entity_key)
SELECT 'b:' || id FROM boards
UNION ALL SELECT 'c:' || card_id FROM note_cards
UNION ALL SELECT 'c:' || card_id FROM embed_cards
UNION ALL SELECT 'c:' || card_id FROM image_cards
UNION ALL SELECT 'c:' || card_id FROM file_cards
UNION ALL SELECT 'c:' || card_id FROM filesystem_aliases;

INSERT INTO search_index (rowid, entity_id, kind, board_id, title, body)
SELECT k.id, b.id, 'board', b.id, b.title, ''
FROM boards b JOIN search_index_keys k ON k.entity_key = 'b:' || b.id;

INSERT INTO search_index (rowid, entity_id, kind, board_id, title, body)
SELECT k.id, n.card_id, 'note', c.board_id, '', n.plain_text
FROM note_cards n
JOIN search_index_keys k ON k.entity_key = 'c:' || n.card_id
LEFT JOIN cards c ON c.id = n.card_id;

INSERT INTO search_index (rowid, entity_id, kind, board_id, title, body)
SELECT k.id, e.card_id, 'embed', c.board_id,
       COALESCE(e.title, '') || ' ' || e.source_url || ' ' || e.display_url,
       e.description_plain_text
FROM embed_cards e
JOIN search_index_keys k ON k.entity_key = 'c:' || e.card_id
LEFT JOIN cards c ON c.id = e.card_id;

INSERT INTO search_index (rowid, entity_id, kind, board_id, title, body)
SELECT k.id, i.card_id, 'image', c.board_id, '',
       i.caption_plain_text || ' ' || COALESCE(a.file_name, '')
FROM image_cards i
JOIN search_index_keys k ON k.entity_key = 'c:' || i.card_id
LEFT JOIN cards c ON c.id = i.card_id
LEFT JOIN assets a ON a.id = i.asset_id;

INSERT INTO search_index (rowid, entity_id, kind, board_id, title, body)
SELECT k.id, f.card_id, 'file', c.board_id, COALESCE(a.file_name, ''), f.preview_text
FROM file_cards f
JOIN search_index_keys k ON k.entity_key = 'c:' || f.card_id
LEFT JOIN cards c ON c.id = f.card_id
LEFT JOIN assets a ON a.id = f.asset_id;

INSERT INTO search_index (rowid, entity_id, kind, board_id, title, body)
SELECT k.id, fa.card_id, 'filesystem_alias', c.board_id, fa.display_name, fa.path_hint
FROM filesystem_aliases fa
JOIN search_index_keys k ON k.entity_key = 'c:' || fa.card_id
LEFT JOIN cards c ON c.id = fa.card_id;
