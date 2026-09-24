//! Storage for device identity (`local_meta`, `known_devices`) and the Rust
//! step of migration 0024 (ADR-0012). See `domain::device` for the model.

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use crate::db::migrations::now_millis;
use crate::domain::device::{
    default_device_name, normalize_device_name, DeviceIdentity, DEVICE_ID_KEY, DEVICE_NAME_KEY,
    MACHINE_FINGERPRINT_KEY,
};
use crate::domain::errors::WorkspaceError;

use super::immediate_tx;

fn meta(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM local_meta WHERE key = ?1", [key], |r| {
        r.get(0)
    })
    .optional()
}

fn upsert_known_device(conn: &Connection, identity: &DeviceIdentity) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO known_devices (device_id, name, last_seen_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at",
        params![identity.device_id, identity.device_name, now_millis()],
    )?;
    Ok(())
}

/// Creates this installation's identity on first run: a UUIDv7 `device_id`
/// and a `device_name` defaulting to the host name, and (re)seeds this
/// device's `known_devices` row. Idempotent.
///
/// `fingerprint` is this machine's [`machine_fingerprint`] (bootstrap passes
/// it; the 0024 migration step, which has no data directory, passes `None`):
/// - no fingerprint stored yet (first run after 0024, fresh install): store it;
/// - the stored one differs: this database was copied to another machine (or
///   user account, or the host was renamed). Mint a NEW `device_id` and name,
///   add it to `known_devices`, keep the previous device's row (so its
///   shortcuts read "On <old name>"), and store the new fingerprint. Existing
///   aliases keep their `origin_device_id` and the old device's locators no
///   longer match: they render foreign with "Point to…" (ADR-0012).
///
/// [`machine_fingerprint`]: crate::domain::device::machine_fingerprint
pub fn ensure_device_identity(
    conn: &Connection,
    fingerprint: Option<&str>,
) -> rusqlite::Result<DeviceIdentity> {
    if let Some(fingerprint) = fingerprint {
        let stored = meta(conn, MACHINE_FINGERPRINT_KEY)?;
        let had_identity = meta(conn, DEVICE_ID_KEY)?.is_some();
        if had_identity && stored.as_deref().is_some_and(|s| s != fingerprint) {
            // Another machine: forget this installation's identity here; the
            // INSERT OR IGNOREs below mint the new one. `known_devices` keeps
            // the previous device's row.
            conn.execute(
                "DELETE FROM local_meta WHERE key IN (?1, ?2)",
                params![DEVICE_ID_KEY, DEVICE_NAME_KEY],
            )?;
        }
        conn.execute(
            "INSERT INTO local_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![MACHINE_FINGERPRINT_KEY, fingerprint],
        )?;
    }
    conn.execute(
        "INSERT OR IGNORE INTO local_meta (key, value) VALUES (?1, ?2)",
        params![DEVICE_ID_KEY, uuid::Uuid::now_v7().to_string()],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO local_meta (key, value) VALUES (?1, ?2)",
        params![DEVICE_NAME_KEY, default_device_name()],
    )?;
    let identity = DeviceIdentity {
        device_id: meta(conn, DEVICE_ID_KEY)?.unwrap_or_default(),
        device_name: meta(conn, DEVICE_NAME_KEY)?.unwrap_or_default(),
    };
    upsert_known_device(conn, &identity)?;
    Ok(identity)
}

/// This installation's identity. Fails if it was never created (a database
/// that did not go through migration 0024).
pub fn load_device_identity(conn: &Connection) -> Result<DeviceIdentity, WorkspaceError> {
    let missing = || WorkspaceError::Database("device identity is missing".into());
    Ok(DeviceIdentity {
        device_id: meta(conn, DEVICE_ID_KEY)?.ok_or_else(missing)?,
        device_name: meta(conn, DEVICE_NAME_KEY)?.ok_or_else(missing)?,
    })
}

/// This installation's `device_id`.
pub fn current_device_id(conn: &Connection) -> Result<String, WorkspaceError> {
    meta(conn, DEVICE_ID_KEY)?
        .ok_or_else(|| WorkspaceError::Database("device identity is missing".into()))
}

/// Renames this device (local_meta + its known_devices row, one transaction).
pub fn rename_device(conn: &mut Connection, name: &str) -> Result<DeviceIdentity, WorkspaceError> {
    let name = normalize_device_name(name)?;
    let tx = immediate_tx(conn)?;
    let device_id = current_device_id(&tx)?;
    tx.execute(
        "UPDATE local_meta SET value = ?2 WHERE key = ?1",
        params![DEVICE_NAME_KEY, name],
    )?;
    let identity = DeviceIdentity {
        device_id,
        device_name: name,
    };
    upsert_known_device(&tx, &identity)?;
    tx.commit()?;
    Ok(identity)
}

/// True when `table` has a column named `column`.
fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |r| r.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The 0024 backfill (ADR-0012 §1–2): every alias without an origin is
/// attributed to `device_id`; while the legacy `filesystem_aliases.locator_blob`
/// column still exists its bytes are copied into `filesystem_alias_locators`
/// for `device_id` and the column is then dropped. Returns the number of
/// aliases attributed.
///
/// Idempotent: a second run finds no NULL origins and no legacy column and
/// changes nothing; `INSERT OR IGNORE` never overwrites a locator row. Runs in
/// the caller's transaction (the migration's).
pub fn backfill_device_scoped_locators(
    conn: &Connection,
    device_id: &str,
) -> rusqlite::Result<usize> {
    let legacy_column = has_column(conn, "filesystem_aliases", "locator_blob")?;
    if legacy_column {
        conn.execute(
            "INSERT OR IGNORE INTO filesystem_alias_locators (card_id, device_id, locator_blob)
             SELECT card_id, ?1, locator_blob FROM filesystem_aliases
             WHERE origin_device_id IS NULL AND locator_blob IS NOT NULL",
            [device_id],
        )?;
    }
    let attributed = conn.execute(
        "UPDATE filesystem_aliases SET origin_device_id = ?1 WHERE origin_device_id IS NULL",
        [device_id],
    )?;
    if legacy_column {
        conn.execute_batch("ALTER TABLE filesystem_aliases DROP COLUMN locator_blob;")?;
    }
    Ok(attributed)
}

/// Rust step of migration 0024, run inside the migration transaction after
/// the SQL file: identity first (the backfill needs the id), then backfill
/// and the column drop.
pub fn migrate_0024(tx: &Transaction) -> rusqlite::Result<()> {
    // No data directory here: bootstrap stores the fingerprint right after.
    let identity = ensure_device_identity(tx, None)?;
    backfill_device_scoped_locators(tx, &identity.device_id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The 0023 shape of `filesystem_aliases` plus the 0024 DDL, built by hand
    /// so the backfill is tested against exactly the state it must handle.
    fn legacy_state() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE cards (id TEXT PRIMARY KEY);
             CREATE TABLE filesystem_aliases (
                 card_id TEXT PRIMARY KEY REFERENCES cards(id),
                 target_kind TEXT NOT NULL,
                 locator_blob BLOB NOT NULL,
                 path_hint TEXT NOT NULL,
                 display_name TEXT NOT NULL
             );
             INSERT INTO cards (id) VALUES ('a1'), ('a2');
             INSERT INTO filesystem_aliases VALUES
                 ('a1', 'folder', X'626F6F6B01', '/Users/me/A', 'A'),
                 ('a2', 'folder', X'626F6F6B02', '/Users/me/B', 'B');",
        )
        .unwrap();
        conn.execute_batch(include_str!(
            "../../migrations/0024_device_scoped_locators.sql"
        ))
        .unwrap();
        conn
    }

    #[test]
    fn backfill_moves_locators_to_this_device_and_drops_the_column() {
        let mut conn = legacy_state();
        let tx = conn.transaction().unwrap();
        migrate_0024(&tx).unwrap();
        tx.commit().unwrap();

        let identity = load_device_identity(&conn).unwrap();
        assert!(uuid::Uuid::parse_str(&identity.device_id).is_ok());
        assert!(!identity.device_name.is_empty());

        let origins: Vec<String> = conn
            .prepare("SELECT origin_device_id FROM filesystem_aliases ORDER BY card_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(origins, vec![identity.device_id.clone(); 2]);

        let locators: Vec<(String, String, Vec<u8>)> = conn
            .prepare(
                "SELECT card_id, device_id, locator_blob FROM filesystem_alias_locators ORDER BY card_id",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            locators,
            vec![
                (
                    "a1".into(),
                    identity.device_id.clone(),
                    b"book\x01".to_vec()
                ),
                (
                    "a2".into(),
                    identity.device_id.clone(),
                    b"book\x02".to_vec()
                ),
            ]
        );
        assert!(!has_column(&conn, "filesystem_aliases", "locator_blob").unwrap());

        let known: String = conn
            .query_row(
                "SELECT name FROM known_devices WHERE device_id = ?1",
                [&identity.device_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(known, identity.device_name);
    }

    #[test]
    fn backfill_is_idempotent() {
        let mut conn = legacy_state();
        let tx = conn.transaction().unwrap();
        migrate_0024(&tx).unwrap();
        let first = load_device_identity(&tx).unwrap();
        // Second run inside the same transaction: nothing left to do.
        assert_eq!(
            backfill_device_scoped_locators(&tx, &first.device_id).unwrap(),
            0
        );
        assert_eq!(ensure_device_identity(&tx, None).unwrap(), first);
        tx.commit().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM filesystem_alias_locators", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn a_failed_backfill_rolls_back_with_its_transaction() {
        let mut conn = legacy_state();
        {
            let tx = conn.transaction().unwrap();
            migrate_0024(&tx).unwrap();
            // Dropped without commit: rollback.
        }
        assert!(has_column(&conn, "filesystem_aliases", "locator_blob").unwrap());
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_meta", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn rename_updates_meta_and_known_devices() {
        let mut conn = legacy_state();
        ensure_device_identity(&conn, None).unwrap();
        let renamed = rename_device(&mut conn, "  Studio  ").unwrap();
        assert_eq!(renamed.device_name, "Studio");
        assert_eq!(load_device_identity(&conn).unwrap(), renamed);
        assert!(rename_device(&mut conn, "   ").is_err());
        let known: String = conn
            .query_row("SELECT name FROM known_devices", [], |r| r.get(0))
            .unwrap();
        assert_eq!(known, "Studio");
    }

    fn alias_row(conn: &Connection, origin: &str) {
        conn.execute_batch(&format!(
            "INSERT INTO cards (id) VALUES ('fa');
             INSERT INTO filesystem_aliases (card_id, target_kind, path_hint, display_name, origin_device_id)
                 VALUES ('fa', 'folder', '/Users/me/A', 'A', '{origin}');
             INSERT INTO filesystem_alias_locators (card_id, device_id, locator_blob)
                 VALUES ('fa', '{origin}', X'626F6F6B');"
        ))
        .unwrap();
    }

    /// `local` exactly as the alias projection computes it.
    fn alias_is_local(conn: &Connection) -> bool {
        conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM filesystem_alias_locators l WHERE l.card_id = 'fa'
                 AND l.device_id = (SELECT value FROM local_meta WHERE key = 'device_id'))",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn the_same_fingerprint_keeps_the_identity() {
        let mut conn = legacy_state();
        let tx = conn.transaction().unwrap();
        migrate_0024(&tx).unwrap();
        tx.commit().unwrap();
        let first = ensure_device_identity(&conn, Some("fp-mac")).unwrap();
        alias_row(&conn, &first.device_id);
        assert_eq!(
            ensure_device_identity(&conn, Some("fp-mac")).unwrap(),
            first
        );
        assert_eq!(ensure_device_identity(&conn, None).unwrap(), first);
        assert!(alias_is_local(&conn));
        assert_eq!(
            meta(&conn, MACHINE_FINGERPRINT_KEY).unwrap().as_deref(),
            Some("fp-mac")
        );
    }

    #[test]
    fn a_changed_fingerprint_mints_a_new_identity_and_keeps_the_old_device() {
        let mut conn = legacy_state();
        let tx = conn.transaction().unwrap();
        migrate_0024(&tx).unwrap();
        tx.commit().unwrap();
        // A pre-existing install: the first fingerprinted run just records it.
        let mac = ensure_device_identity(&conn, Some("fp-mac")).unwrap();
        rename_device(&mut conn, "Studio Mac").unwrap();
        alias_row(&conn, &mac.device_id);

        // The database file is opened on another machine.
        let pc = ensure_device_identity(&conn, Some("fp-pc")).unwrap();
        assert_ne!(pc.device_id, mac.device_id);
        assert!(uuid::Uuid::parse_str(&pc.device_id).is_ok());
        assert_eq!(load_device_identity(&conn).unwrap(), pc);
        assert_eq!(
            meta(&conn, MACHINE_FINGERPRINT_KEY).unwrap().as_deref(),
            Some("fp-pc")
        );

        let known: Vec<(String, String)> = conn
            .prepare("SELECT device_id, name FROM known_devices ORDER BY device_id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(known.contains(&(mac.device_id.clone(), "Studio Mac".to_string())));
        assert!(known.contains(&(pc.device_id.clone(), pc.device_name.clone())));

        let origin: String = conn
            .query_row(
                "SELECT origin_device_id FROM filesystem_aliases WHERE card_id = 'fa'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            origin, mac.device_id,
            "the alias stays attributed to the Mac"
        );
        assert!(!alias_is_local(&conn), "and reads local: false here");

        // Stable from now on.
        assert_eq!(ensure_device_identity(&conn, Some("fp-pc")).unwrap(), pc);
    }
}
