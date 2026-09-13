-- 0017_operation_receipts.sql
-- General receipt store for operations that change several aggregates at once
-- (ADR-0007). The existing `mutation_receipts` table carries `card_ids` for single
-- card mutations and cannot describe a mixed-selection move, whose undo needs both
-- card and board state.
--
-- `idempotency_key` identifies one operation: a replay must return the original
-- receipt instead of hitting a stale revision, and a replay with the same key but
-- a different payload is rejected by comparing `request_fingerprint`.
-- `receipt_json` holds the typed receipt; the shape is owned by Rust, not SQL.

CREATE TABLE operation_receipts (
    operation_id TEXT PRIMARY KEY,
    operation_kind TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_operation_receipts_idempotency
    ON operation_receipts(operation_kind, idempotency_key);
