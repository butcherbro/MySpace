-- 0011_note_color.sql
-- Note background color: a semantic preset id stored on the note card.
--
-- Only the preset id ('default', 'yellow', 'pink', …) is persisted; the actual
-- color resolves from CSS design tokens at render time, so the palette can
-- change without a data migration. Old notes fall back to 'default'.

ALTER TABLE note_cards
    ADD COLUMN color_token TEXT NOT NULL DEFAULT 'default'
        CHECK(color_token IN ('default', 'yellow', 'pink', 'lavender', 'blue', 'green', 'gray'));
