-- 0001_workspace.sql
-- V1 workspace schema. See docs/plans/2026-08-28-visual-workspace-v1.md, Section C.

PRAGMA foreign_keys = ON;

CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    root_board_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE boards (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    parent_board_id TEXT REFERENCES boards(id),
    title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
    color_token TEXT NOT NULL,
    symbol TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    trash_batch_id TEXT,
    CHECK(parent_board_id IS NULL OR parent_board_id <> id)
);

CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id),
    kind TEXT NOT NULL CHECK(kind IN ('note', 'board_portal')),
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL NOT NULL CHECK(width >= 120 AND width <= 1600),
    height REAL NOT NULL CHECK(height >= 48 AND height <= 10000),
    z_index INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    trash_batch_id TEXT
);

CREATE TABLE note_cards (
    card_id TEXT PRIMARY KEY REFERENCES cards(id),
    document_json TEXT NOT NULL,
    plain_text TEXT NOT NULL DEFAULT ''
);

CREATE TABLE board_portal_cards (
    card_id TEXT PRIMARY KEY REFERENCES cards(id),
    target_board_id TEXT NOT NULL UNIQUE REFERENCES boards(id)
);

CREATE TABLE board_view_states (
    board_id TEXT PRIMARY KEY REFERENCES boards(id),
    viewport_x REAL NOT NULL DEFAULT 0,
    viewport_y REAL NOT NULL DEFAULT 0,
    zoom REAL NOT NULL DEFAULT 1 CHECK(zoom BETWEEN 0.1 AND 4),
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
);

CREATE INDEX idx_boards_parent_active
    ON boards(parent_board_id, deleted_at);
CREATE INDEX idx_cards_board_active
    ON cards(board_id, deleted_at, z_index);
CREATE INDEX idx_cards_trash_batch
    ON cards(trash_batch_id);
CREATE INDEX idx_boards_trash_batch
    ON boards(trash_batch_id);
