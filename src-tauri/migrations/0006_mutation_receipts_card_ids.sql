-- 0006_mutation_receipts_card_ids.sql
-- Fix the mutation_receipts schema: the first 0005 used only (idempotency_key,
-- batch_id, created_at) without recording which card ids a replayed batch
-- produced. Recreation adds card_ids so idempotent replay returns the exact
-- original result. The table is empty in V1 (no agent writes yet), so a safe
-- recreate matches the embed_cards migration pattern.

CREATE TABLE mutation_receipts_new (
    idempotency_key TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    card_ids TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

INSERT INTO mutation_receipts_new (idempotency_key, batch_id, card_ids, created_at)
SELECT idempotency_key, batch_id, '[]', created_at FROM mutation_receipts;

DROP TABLE mutation_receipts;
ALTER TABLE mutation_receipts_new RENAME TO mutation_receipts;
