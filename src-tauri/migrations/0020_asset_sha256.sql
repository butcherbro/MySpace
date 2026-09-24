-- Content-addressed assets (P1.2, ADR-0011 §4). `sha256` is the lowercase hex
-- SHA-256 of the stored file. Nullable: rows created before this migration are
-- filled in by the background `maintenance.hash_assets` job; new imports hash
-- on write. The on-disk layout (`assets/<uuid>.<ext>`) is unchanged: the hash
-- is metadata used for import dedup, backups and (later) sync blob exchange.

ALTER TABLE assets ADD COLUMN sha256 TEXT;
CREATE INDEX idx_assets_sha256 ON assets(sha256) WHERE sha256 IS NOT NULL;
