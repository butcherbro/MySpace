-- Indexes for hot lookup paths that were previously full table scans:
-- asset GC (finding which cards/boards reference a given asset), backup
-- integrity checks, and trash listing (deleted_at IS NOT NULL). Purely
-- additive; safe to re-run.
--
-- IMPORTANT: idx_cards_trashed indexes `cards`. Any future migration that
-- rebuilds the `cards` table (e.g. widening a CHECK constraint via
-- create-copy-drop-rename) drops this index along with the table, and MUST
-- recreate `idx_cards_trashed` (and ideally the other cards-adjacent indexes
-- below) as part of that migration.

CREATE INDEX IF NOT EXISTS idx_image_cards_asset ON image_cards(asset_id);
CREATE INDEX IF NOT EXISTS idx_embed_cards_asset ON embed_cards(asset_id);
CREATE INDEX IF NOT EXISTS idx_embed_cards_favicon_asset ON embed_cards(favicon_asset_id);
CREATE INDEX IF NOT EXISTS idx_file_cards_asset ON file_cards(asset_id);
CREATE INDEX IF NOT EXISTS idx_file_cards_preview_asset ON file_cards(preview_asset_id);
CREATE INDEX IF NOT EXISTS idx_boards_cover_asset ON boards(cover_asset_id);
CREATE INDEX IF NOT EXISTS idx_favicon_cache_asset ON favicon_cache(asset_id);
CREATE INDEX IF NOT EXISTS idx_mutation_receipts_batch ON mutation_receipts(batch_id);
CREATE INDEX IF NOT EXISTS idx_cards_trashed ON cards(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_boards_trashed ON boards(deleted_at) WHERE deleted_at IS NOT NULL;
