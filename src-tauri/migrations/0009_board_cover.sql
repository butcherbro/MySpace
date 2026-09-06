-- 0009_board_cover.sql
-- A Board Portal may have an optional cover image that replaces the color/symbol
-- tile while preserving the same silhouette. The cover is a managed asset
-- (never raw clipboard bytes): boards.cover_asset_id references assets(id).
-- NULL means "use the deterministic color token + symbol fallback".

ALTER TABLE boards
    ADD COLUMN cover_asset_id TEXT REFERENCES assets(id);
