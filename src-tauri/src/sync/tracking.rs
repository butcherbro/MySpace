//! Which entities a write touched, and turning that into journal rows.
//!
//! The writer connection carries TEMP triggers (installed by
//! [`ensure_installed`], per connection, never in the database file) on every
//! synced table. They record `(entity_kind, entity_id, register)` into
//! `temp.sync_dirty` whenever a register's columns actually change; a hard
//! delete of a card or board records the pseudo-register `purge`. The funnel
//! clears the set before a mutation and calls [`flush`] before `COMMIT`, which
//! writes one `changes` row per touched entity. Detection by trigger instead
//! of by mutation variant means a new mutation, or a new code path inside an
//! old one, cannot forget to journal what it wrote.
//!
//! Tracked: `boards`, `cards`, every kind detail table ([`DETAIL_TABLES`]),
//! `assets` (insert/update only: asset GC is per replica) and `quick_boards`.
//! Not tracked (never journaled): `LOCAL_ONLY_TABLES`, the derived search
//! index and `change_seq`, `favicon_cache` (a per-device fetch cache),
//! idempotency receipts (`mutation_receipts`, `operation_receipts`) and
//! `workspaces` (each device owns its own row).

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection, OptionalExtension};

use super::hlc::{self, Hlc};
use super::image::{registers, Cause, Envelope, IMAGE_VERSION};
use super::{
    board_to_wire, journal, ChangeRow, ENTITY_ASSET, ENTITY_BOARD, ENTITY_CARD, ENTITY_QUICK_BOARD,
};
use crate::domain::errors::WorkspaceError;

/// Every card-kind detail table (`card_id` → `cards.id`). A test checks this
/// against the schema so a new kind's table cannot be left untracked.
pub const DETAIL_TABLES: &[&str] = &[
    "note_cards",
    "board_portal_cards",
    "image_cards",
    "embed_cards",
    "filesystem_aliases",
    "file_cards",
    "board_shortcut_cards",
];

/// Pseudo-register recorded by a hard delete.
pub const PURGE: &str = "purge";

fn tracking_sql() -> String {
    let mut sql = String::from(
        "CREATE TEMP TABLE IF NOT EXISTS sync_dirty (
            entity_kind TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            field TEXT NOT NULL,
            PRIMARY KEY (entity_kind, entity_id, field)
         ) WITHOUT ROWID;

         CREATE TEMP TRIGGER IF NOT EXISTS sync_cards_ai AFTER INSERT ON main.cards BEGIN
            INSERT OR IGNORE INTO sync_dirty VALUES
                ('card', NEW.id, 'place'), ('card', NEW.id, 'life'), ('card', NEW.id, 'body');
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS sync_cards_au_place
         AFTER UPDATE OF board_id, x, y, width, height, z_index, unsorted ON main.cards
         WHEN OLD.board_id IS NOT NEW.board_id OR OLD.x IS NOT NEW.x OR OLD.y IS NOT NEW.y
           OR OLD.width IS NOT NEW.width OR OLD.height IS NOT NEW.height
           OR OLD.z_index IS NOT NEW.z_index OR OLD.unsorted IS NOT NEW.unsorted
         BEGIN
            INSERT OR IGNORE INTO sync_dirty VALUES ('card', NEW.id, 'place');
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS sync_cards_au_life
         AFTER UPDATE OF deleted_at, trash_batch_id ON main.cards
         WHEN OLD.deleted_at IS NOT NEW.deleted_at OR OLD.trash_batch_id IS NOT NEW.trash_batch_id
         BEGIN
            INSERT OR IGNORE INTO sync_dirty VALUES ('card', NEW.id, 'life');
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS sync_cards_au_kind
         AFTER UPDATE OF kind ON main.cards WHEN OLD.kind IS NOT NEW.kind
         BEGIN
            INSERT OR IGNORE INTO sync_dirty VALUES ('card', NEW.id, 'body');
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS sync_cards_ad AFTER DELETE ON main.cards BEGIN
            INSERT OR IGNORE INTO sync_dirty VALUES ('card', OLD.id, 'purge');
         END;

         CREATE TEMP TRIGGER IF NOT EXISTS sync_boards_ai AFTER INSERT ON main.boards BEGIN
            INSERT OR IGNORE INTO sync_dirty VALUES
                ('board', NEW.id, 'meta'), ('board', NEW.id, 'place'), ('board', NEW.id, 'life');
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS sync_boards_au_meta
         AFTER UPDATE OF title, color_token, symbol, cover_asset_id ON main.boards
         WHEN OLD.title IS NOT NEW.title OR OLD.color_token IS NOT NEW.color_token
           OR OLD.symbol IS NOT NEW.symbol OR OLD.cover_asset_id IS NOT NEW.cover_asset_id
         BEGIN
            INSERT OR IGNORE INTO sync_dirty VALUES ('board', NEW.id, 'meta');
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS sync_boards_au_place
         AFTER UPDATE OF parent_board_id ON main.boards
         WHEN OLD.parent_board_id IS NOT NEW.parent_board_id
         BEGIN
            INSERT OR IGNORE INTO sync_dirty VALUES ('board', NEW.id, 'place');
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS sync_boards_au_life
         AFTER UPDATE OF deleted_at, trash_batch_id ON main.boards
         WHEN OLD.deleted_at IS NOT NEW.deleted_at OR OLD.trash_batch_id IS NOT NEW.trash_batch_id
         BEGIN
            INSERT OR IGNORE INTO sync_dirty VALUES ('board', NEW.id, 'life');
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS sync_boards_ad AFTER DELETE ON main.boards BEGIN
            INSERT OR IGNORE INTO sync_dirty VALUES ('board', OLD.id, 'purge');
         END;

         CREATE TEMP TRIGGER IF NOT EXISTS sync_assets_ai AFTER INSERT ON main.assets BEGIN
            INSERT OR IGNORE INTO sync_dirty VALUES ('asset', NEW.id, 'body');
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS sync_assets_au AFTER UPDATE ON main.assets BEGIN
            INSERT OR IGNORE INTO sync_dirty VALUES ('asset', NEW.id, 'body');
         END;

         CREATE TEMP TRIGGER IF NOT EXISTS sync_quick_boards_ai AFTER INSERT ON main.quick_boards BEGIN
            INSERT OR IGNORE INTO sync_dirty VALUES ('quick_board', NEW.board_id, 'body');
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS sync_quick_boards_au AFTER UPDATE ON main.quick_boards BEGIN
            INSERT OR IGNORE INTO sync_dirty VALUES ('quick_board', NEW.board_id, 'body');
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS sync_quick_boards_ad AFTER DELETE ON main.quick_boards BEGIN
            INSERT OR IGNORE INTO sync_dirty VALUES ('quick_board', OLD.board_id, 'body');
         END;
        ",
    );
    for table in DETAIL_TABLES {
        for (suffix, event, row) in [
            ("ai", "INSERT", "NEW"),
            ("au", "UPDATE", "NEW"),
            ("ad", "DELETE", "OLD"),
        ] {
            sql.push_str(&format!(
                "CREATE TEMP TRIGGER IF NOT EXISTS sync_{table}_{suffix} AFTER {event} ON main.{table} BEGIN
                    INSERT OR IGNORE INTO sync_dirty VALUES ('card', {row}.card_id, 'body');
                 END;\n"
            ));
        }
    }
    sql
}

/// Installs the dirty-tracking temp table and triggers on `conn` (idempotent;
/// one lookup when already installed).
pub fn ensure_installed(conn: &Connection) -> Result<(), WorkspaceError> {
    let installed: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM temp.sqlite_master WHERE type = 'table' AND name = 'sync_dirty')",
        [],
        |r| r.get(0),
    )?;
    if !installed {
        conn.execute_batch(&tracking_sql())?;
    }
    Ok(())
}

/// Forgets every recorded touch (the start of a mutation; after a replay).
pub fn clear(conn: &Connection) -> Result<(), WorkspaceError> {
    conn.execute("DELETE FROM temp.sync_dirty", [])?;
    Ok(())
}

/// Marks every synced entity dirty on every register (journal backfill).
pub fn mark_everything(conn: &Connection) -> Result<(), WorkspaceError> {
    conn.execute_batch(
        "INSERT OR IGNORE INTO temp.sync_dirty
            SELECT 'board', id, 'meta' FROM main.boards
            UNION ALL SELECT 'board', id, 'place' FROM main.boards
            UNION ALL SELECT 'board', id, 'life' FROM main.boards
            UNION ALL SELECT 'asset', id, 'body' FROM main.assets
            UNION ALL SELECT 'card', id, 'place' FROM main.cards
            UNION ALL SELECT 'card', id, 'life' FROM main.cards
            UNION ALL SELECT 'card', id, 'body' FROM main.cards
            UNION ALL SELECT 'quick_board', board_id, 'body' FROM main.quick_boards;",
    )?;
    Ok(())
}

/// The registers' clocks currently applied for one entity (wire id).
pub fn load_clocks(
    conn: &Connection,
    entity_kind: &str,
    wire_id: &str,
) -> Result<BTreeMap<String, String>, WorkspaceError> {
    let mut stmt = conn.prepare_cached(
        "SELECT field, hlc FROM entity_clocks WHERE entity_kind = ?1 AND entity_id = ?2",
    )?;
    let rows = stmt.query_map(params![entity_kind, wire_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn set_clock(
    conn: &Connection,
    entity_kind: &str,
    wire_id: &str,
    field: &str,
    hlc: &str,
) -> Result<(), WorkspaceError> {
    conn.prepare_cached(
        "INSERT INTO entity_clocks (entity_kind, entity_id, field, hlc) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(entity_kind, entity_id, field) DO UPDATE SET hlc = excluded.hlc",
    )?
    .execute(params![entity_kind, wire_id, field, hlc])?;
    Ok(())
}

/// Records a purge tombstone and drops the entity's clocks.
pub fn record_purge(
    conn: &Connection,
    entity_kind: &str,
    wire_id: &str,
    hlc: &str,
) -> Result<(), WorkspaceError> {
    conn.execute(
        "INSERT INTO purged (entity_kind, entity_id, hlc) VALUES (?1, ?2, ?3)
         ON CONFLICT(entity_kind, entity_id) DO UPDATE SET hlc = MAX(hlc, excluded.hlc)",
        params![entity_kind, wire_id, hlc],
    )?;
    conn.execute(
        "DELETE FROM entity_clocks WHERE entity_kind = ?1 AND entity_id = ?2",
        params![entity_kind, wire_id],
    )?;
    Ok(())
}

/// Emission order inside one flush: parents before children on create,
/// children before parents on purge, assets before the cards that use them.
fn rank(kind: &str, purge: bool) -> u8 {
    match (kind, purge) {
        (ENTITY_BOARD, false) => 0,
        (ENTITY_ASSET, _) => 1,
        (ENTITY_CARD, false) => 2,
        (ENTITY_QUICK_BOARD, _) => 3,
        (ENTITY_CARD, true) => 4,
        (ENTITY_BOARD, true) => 5,
        _ => 6,
    }
}

/// Depth of a local board (root = 0), bounded against a corrupt cycle.
fn board_depth(conn: &Connection, id: &str) -> Result<i64, WorkspaceError> {
    let mut depth = 0i64;
    let mut current = id.to_string();
    while depth < 1_000 {
        let parent: Option<Option<String>> = conn
            .query_row(
                "SELECT parent_board_id FROM boards WHERE id = ?1",
                [&current],
                |r| r.get(0),
            )
            .optional()?;
        match parent.flatten() {
            Some(p) => {
                depth += 1;
                current = p;
            }
            None => break,
        }
    }
    Ok(depth)
}

struct Emit {
    kind: String,
    local_id: String,
    fields: BTreeSet<String>,
    state: Option<serde_json::Value>,
    order: (u8, i64),
}

/// Writes one `changes` row per dirty entity (origin = this device, a fresh
/// HLC each, in dependency order), updates `entity_clocks`, `purged` and this
/// device's cursor, and clears the dirty set. Returns the rows written.
/// Must run inside the mutation's transaction.
pub fn flush(
    conn: &Connection,
    op: &str,
    cause: Option<&Cause>,
) -> Result<Vec<ChangeRow>, WorkspaceError> {
    let dirty: Vec<(String, String, String)> = {
        let mut stmt =
            conn.prepare_cached("SELECT entity_kind, entity_id, field FROM temp.sync_dirty")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    if dirty.is_empty() {
        return Ok(Vec::new());
    }
    clear(conn)?;

    let mut grouped: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    for (kind, id, field) in dirty {
        grouped.entry((kind, id)).or_default().insert(field);
    }

    let device = super::device_id(conn)?;
    let root = super::root_board_id(conn)?;
    let mut emits = Vec::with_capacity(grouped.len());
    for ((kind, local_id), fields) in grouped {
        let state = super::image::read_state(conn, &kind, &local_id, &root)?;
        if state.is_none() && kind == ENTITY_ASSET {
            // Asset rows removed by GC are not journaled (per-replica GC).
            continue;
        }
        let purge = state.is_none();
        let depth = if kind == ENTITY_BOARD && !purge {
            board_depth(conn, &local_id)?
        } else {
            0
        };
        emits.push(Emit {
            order: (rank(&kind, purge), depth),
            kind,
            local_id,
            fields,
            state,
        });
    }
    emits.sort_by(|a, b| a.order.cmp(&b.order));

    let now = crate::db::migrations::now_millis();
    let mut written = Vec::with_capacity(emits.len());
    for emit in emits {
        let hlc: Hlc = hlc::next_local(conn, &device)?;
        let hlc_text = hlc.encode();
        let wire_id = match emit.kind.as_str() {
            ENTITY_BOARD | ENTITY_QUICK_BOARD => board_to_wire(&root, &emit.local_id),
            _ => emit.local_id.clone(),
        };
        let (op_name, envelope) = match emit.state {
            None => {
                record_purge(conn, &emit.kind, &wire_id, &hlc_text)?;
                (super::OP_PURGE, Envelope::tombstone())
            }
            Some(state) => {
                let current = load_clocks(conn, &emit.kind, &wire_id)?;
                let mut clocks = BTreeMap::new();
                let mut prev = BTreeMap::new();
                for register in registers(&emit.kind) {
                    let set_here = emit.fields.contains(*register) || emit.fields.contains(PURGE);
                    match current.get(*register) {
                        Some(old) if !set_here => {
                            clocks.insert(register.to_string(), old.clone());
                        }
                        old => {
                            if let Some(old) = old {
                                prev.insert(register.to_string(), old.clone());
                            }
                            clocks.insert(register.to_string(), hlc_text.clone());
                            set_clock(conn, &emit.kind, &wire_id, register, &hlc_text)?;
                        }
                    }
                }
                (
                    op,
                    Envelope {
                        v: IMAGE_VERSION,
                        purge: false,
                        clocks,
                        prev,
                        state,
                        cause: cause.cloned(),
                    },
                )
            }
        };
        let row = ChangeRow {
            origin_device_id: device.clone(),
            hlc: hlc_text,
            entity_kind: emit.kind,
            entity_id: wire_id,
            op: op_name.to_string(),
            payload_json: envelope.encode(),
        };
        journal::insert_change(conn, &row, now)?;
        journal::advance_cursor(conn, &row.origin_device_id, &row.hlc)?;
        written.push(row);
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_card_detail_table_is_tracked() {
        let conn = crate::db::open_in_memory().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT m.name FROM sqlite_master m
                 JOIN pragma_foreign_key_list(m.name) f
                 WHERE m.type = 'table' AND f.\"table\" = 'cards' AND f.\"from\" = 'card_id'
                 ORDER BY m.name",
            )
            .unwrap();
        let tables: BTreeSet<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let mut expected: BTreeSet<String> = DETAIL_TABLES.iter().map(|t| t.to_string()).collect();
        // The locator table references cards but is device-local (ADR-0012).
        expected.insert("filesystem_alias_locators".into());
        assert_eq!(tables, expected);
    }

    #[test]
    fn triggers_record_registers_only_when_values_change() {
        let mut conn = crate::db::open_in_memory().unwrap();
        crate::db::bootstrap::bootstrap(&mut conn).unwrap();
        ensure_installed(&conn).unwrap();
        ensure_installed(&conn).unwrap();
        let home: String = conn
            .query_row("SELECT root_board_id FROM workspaces", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO cards (id, board_id, kind, x, y, width, height, created_at, updated_at)
             VALUES ('c', ?1, 'note', 0, 0, 200, 100, 0, 0)",
            [&home],
        )
        .unwrap();
        let dirty = |conn: &Connection| -> Vec<String> {
            conn.prepare("SELECT entity_kind || ':' || field FROM temp.sync_dirty ORDER BY 1")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(dirty(&conn), ["card:body", "card:life", "card:place"]);
        clear(&conn).unwrap();
        conn.execute(
            "UPDATE cards SET revision = revision + 1, x = 0 WHERE id = 'c'",
            [],
        )
        .unwrap();
        assert!(dirty(&conn).is_empty(), "no register value changed");
        conn.execute("UPDATE cards SET x = 5 WHERE id = 'c'", [])
            .unwrap();
        conn.execute("UPDATE boards SET change_seq = change_seq + 1", [])
            .unwrap();
        assert_eq!(dirty(&conn), ["card:place"]);
        clear(&conn).unwrap();
        conn.execute("DELETE FROM cards WHERE id = 'c'", [])
            .unwrap();
        assert_eq!(dirty(&conn), ["card:purge"]);
    }
}
