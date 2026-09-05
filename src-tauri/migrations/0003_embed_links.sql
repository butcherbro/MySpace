-- 0003_embed_links.sql
-- Widen the embed card into the full Link Card (link preview) contract, see
-- docs/specs/link-card-and-clipboard.md. The user-facing "Link Card" is the
-- existing domain `embed` kind; we extend `embed_cards` rather than adding a
-- parallel `link_cards` table or a second card kind.
--
-- Fields:
--   source_url         authoritative URL (immutable identity)
--   display_url        the URL shown in the UI (usually the source, can differ)
--   site_name          host/provider display name (nullable)
--   title              clickable title (fallback = URL until metadata loads)
--   provider           oEmbed/provider hint (nullable)
--   description_json   versioned rich-text body (same shape as a note document)
--   description_plain_text  derived plain text for search
--   asset_id           current preview image (fetched OR custom)
--   favicon_asset_id   nullable favicon image
--   preview_origin     'fetched' | 'custom' | NULL (guards against metadata
--                      refresh overwriting a user-selected preview)
--   metadata_status    'pending' | 'ready' | 'failed'
--   metadata_error     human-readable error when metadata_status = 'failed'
--
-- Because `embed_cards` was never populated in V1, we recreate it. The `cards`
-- kind CHECK already whitelists 'embed' (migration 0002), so no rebuild needed.

CREATE TABLE embed_cards_new (
    card_id TEXT PRIMARY KEY REFERENCES cards(id),
    source_url TEXT NOT NULL,
    display_url TEXT NOT NULL,
    site_name TEXT,
    title TEXT,
    provider TEXT,
    description_json TEXT NOT NULL DEFAULT '',
    description_plain_text TEXT NOT NULL DEFAULT '',
    asset_id TEXT REFERENCES assets(id),
    favicon_asset_id TEXT REFERENCES assets(id),
    preview_origin TEXT CHECK(preview_origin IN ('fetched', 'custom')),
    metadata_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(metadata_status IN ('pending', 'ready', 'failed')),
    metadata_error TEXT
);

-- Preserve any rows (url is the authoritative source; there are none in V1 but
-- the copy keeps the migration data-safe if that ever changes).
INSERT INTO embed_cards_new (
    card_id, source_url, display_url, site_name, title, provider,
    asset_id
)
SELECT card_id, url, url, NULL, title, provider, asset_id
FROM embed_cards;

DROP TABLE embed_cards;
ALTER TABLE embed_cards_new RENAME TO embed_cards;
