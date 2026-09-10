-- 0014_file_card_source_path.sql
-- File cards need the original source path so "reveal in Finder" can select the
-- real file (not the managed copy). Additive: existing rows get an empty path
-- and simply fall back to reveal of the stored copy until re-created.

ALTER TABLE file_cards ADD COLUMN source_path TEXT NOT NULL DEFAULT '';
