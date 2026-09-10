-- 0016_favicon_cache.sql
-- Reuse one stored favicon per source URL instead of saving a duplicate copy for
-- every Link Card (10 YouTube links -> 1 favicon asset). Written during
-- enrichment; used to collapse existing duplicates.

CREATE TABLE IF NOT EXISTS favicon_cache (
    source_url TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets(id)
);