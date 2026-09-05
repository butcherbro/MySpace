-- 0007_quick_boards.sql
-- Quick Boards: persistent browser-bookmark-like references to Boards.
--
-- A Quick Board is NOT a tab, a Board Portal Card, a hierarchy edge, a copy, or
-- a move. It is a workspace-scoped stable reference to an existing (non-Home)
-- Board, with an explicit order key persisted independently from Board hierarchy
-- and tab order. Deleting a Board removes its Quick Board reference (FK); Home
-- cannot be pinned (enforced at the service layer, not here, because the
-- root_board_id lives in `workspaces`).
--
-- `sort_order` is a plain integer position. The service rewrites positions
-- transactionally on insert/reorder; it is never inferred from hierarchy.

CREATE TABLE quick_boards (
    board_id TEXT PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Lookups are always by position; the PK already serves dedup/idempotency.
CREATE INDEX idx_quick_boards_order
    ON quick_boards(sort_order, board_id);
