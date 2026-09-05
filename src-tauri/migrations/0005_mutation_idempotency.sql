-- 0005_mutation_idempotency.sql
-- Idempotency receipts for external (agent) mutations. Every agent write carries a
-- caller-supplied idempotency key; a committed receipt makes a replayed key return
-- the same durable result instead of creating duplicates (ADR-0005).

CREATE TABLE mutation_receipts (
    idempotency_key TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    card_ids TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
