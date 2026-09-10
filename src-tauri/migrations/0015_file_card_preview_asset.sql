-- 0015_file_card_preview_asset.sql
-- File cards for PDF/office/HTML get a generated thumbnail (via macOS
-- qlmanage) stored as a managed asset. Additive: existing rows stay null and
-- simply render their old tile/preview.

ALTER TABLE file_cards ADD COLUMN preview_asset_id TEXT REFERENCES assets(id);
