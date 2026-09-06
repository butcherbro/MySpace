-- 0008_embed_description_origin.sql
-- Distinguish a user-authored comment on a Link Card from a site-sourced
-- description. The UI renders a user comment as its own note (separated + bold)
-- and never lets enrichment overwrite it; a site description is a fallback that
-- can be replaced whenever metadata refreshes.
--
-- Values:
--   'user'  — supplied by add_links / edited in the UI; authoritative.
--   'site'  — fetched from the target page by enrichment; fallback only.
--   NULL    — no description yet.
--
-- SQLite has no ALTER for column CHECK constraints on existing tables, but
-- adding a nullable column with a CHECK (below) applies to new rows only, which
-- is exactly what we need here; existing rows default to NULL.

ALTER TABLE embed_cards
    ADD COLUMN description_origin TEXT
        CHECK(description_origin IN ('user', 'site'));