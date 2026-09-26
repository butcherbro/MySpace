//! Storage for the LAN transport (ADR-0011 S3): this device's TLS identity
//! (`local_meta`) and the paired peers (`sync_peers`, migration 0026). Both
//! are local-only. Writes go through the writer funnel as
//! [`Mutation::SyncPeers`](crate::domain::mutation::Mutation::SyncPeers);
//! reads use any connection.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::migrations::now_millis;
use crate::domain::errors::WorkspaceError;

use super::tls;

/// `local_meta` keys of the transport identity.
pub const TLS_CERT_KEY: &str = "sync_tls_cert_pem";
pub const TLS_KEY_KEY: &str = "sync_tls_key_pem";
/// The `device_id` the certificate was minted for: a database copied to
/// another machine gets a new device id (ADR-0012) and therefore a new
/// certificate, so two machines never share a transport identity.
pub const TLS_DEVICE_KEY: &str = "sync_tls_device_id";

/// This device's TLS identity. `fingerprint` is the lowercase hex SHA-256 of
/// the certificate's DER encoding.
#[derive(Clone)]
pub struct TransportIdentity {
    pub device_id: String,
    pub cert_pem: String,
    pub key_pem: String,
    pub fingerprint: String,
}

impl std::fmt::Debug for TransportIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the private key.
        f.debug_struct("TransportIdentity")
            .field("device_id", &self.device_id)
            .field("fingerprint", &self.fingerprint)
            .finish_non_exhaustive()
    }
}

/// A row of `sync_peers`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRecord {
    pub device_id: String,
    pub name: String,
    pub cert_fingerprint: String,
    pub last_address: Option<String>,
    pub paired_at: i64,
    pub last_seen_at: Option<i64>,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
}

/// A local-only write of the transport ([`apply`]).
#[derive(Debug, Clone)]
pub enum PeerWrite {
    /// Mints the certificate on first use (or after the device id changed).
    EnsureTransportIdentity,
    /// Records a successful pairing. Replaces any row with the same device id
    /// or the same fingerprint, and names the device in `known_devices`.
    Upsert {
        device_id: String,
        name: String,
        fingerprint: String,
        address: Option<String>,
    },
    Remove {
        device_id: String,
    },
    /// The outcome of contacting a peer. `name`/`address` refresh the row
    /// when present; `synced` sets `last_sync_at`; `error` replaces
    /// `last_error` (`None` clears it).
    RecordContact {
        device_id: String,
        name: Option<String>,
        address: Option<String>,
        reached: bool,
        synced: bool,
        error: Option<String>,
    },
}

impl PeerWrite {
    /// The peer a write is about (`""` for this device's identity).
    pub fn device_id(&self) -> &str {
        match self {
            Self::EnsureTransportIdentity => "",
            Self::Upsert { device_id, .. }
            | Self::Remove { device_id }
            | Self::RecordContact { device_id, .. } => device_id,
        }
    }
}

/// What a [`PeerWrite`] returns.
#[derive(Debug, Clone)]
pub enum PeerOutcome {
    Identity(TransportIdentity),
    Unit,
}

fn meta(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM local_meta WHERE key = ?1", [key], |r| {
        r.get(0)
    })
    .optional()
}

fn set_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO local_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// The stored identity, if it exists and belongs to the current device id.
pub fn load_transport_identity(
    conn: &Connection,
) -> Result<Option<TransportIdentity>, WorkspaceError> {
    let device_id = super::device_id(conn)?;
    let (Some(cert_pem), Some(key_pem), Some(owner)) = (
        meta(conn, TLS_CERT_KEY)?,
        meta(conn, TLS_KEY_KEY)?,
        meta(conn, TLS_DEVICE_KEY)?,
    ) else {
        return Ok(None);
    };
    if owner != device_id {
        return Ok(None);
    }
    let fingerprint = tls::fingerprint_of_pem(&cert_pem)?;
    Ok(Some(TransportIdentity {
        device_id,
        cert_pem,
        key_pem,
        fingerprint,
    }))
}

fn ensure_transport_identity(conn: &Connection) -> Result<TransportIdentity, WorkspaceError> {
    if let Some(identity) = load_transport_identity(conn)? {
        return Ok(identity);
    }
    let device_id = super::device_id(conn)?;
    let (cert_pem, key_pem) = tls::generate_certificate(&device_id)?;
    set_meta(conn, TLS_CERT_KEY, &cert_pem)?;
    set_meta(conn, TLS_KEY_KEY, &key_pem)?;
    set_meta(conn, TLS_DEVICE_KEY, &device_id)?;
    let fingerprint = tls::fingerprint_of_pem(&cert_pem)?;
    Ok(TransportIdentity {
        device_id,
        cert_pem,
        key_pem,
        fingerprint,
    })
}

fn name_known_device(conn: &Connection, device_id: &str, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO known_devices (device_id, name, last_seen_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at",
        params![device_id, name, now_millis()],
    )?;
    Ok(())
}

/// Executes one write in the funnel's transaction.
pub fn apply(conn: &Connection, write: &PeerWrite) -> Result<PeerOutcome, WorkspaceError> {
    match write {
        PeerWrite::EnsureTransportIdentity => {
            ensure_transport_identity(conn).map(PeerOutcome::Identity)
        }
        PeerWrite::Upsert {
            device_id,
            name,
            fingerprint,
            address,
        } => {
            if *device_id == super::device_id(conn)? {
                return Err(WorkspaceError::ConstraintViolation(
                    "a device cannot pair with itself".into(),
                ));
            }
            conn.execute(
                "DELETE FROM sync_peers WHERE device_id = ?1 OR cert_fingerprint = ?2",
                params![device_id, fingerprint],
            )?;
            let now = now_millis();
            conn.execute(
                "INSERT INTO sync_peers
                    (device_id, name, cert_fingerprint, last_address, paired_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![device_id, name, fingerprint, address, now],
            )?;
            name_known_device(conn, device_id, name)?;
            Ok(PeerOutcome::Unit)
        }
        PeerWrite::Remove { device_id } => {
            conn.execute("DELETE FROM sync_peers WHERE device_id = ?1", [device_id])?;
            Ok(PeerOutcome::Unit)
        }
        PeerWrite::RecordContact {
            device_id,
            name,
            address,
            reached,
            synced,
            error,
        } => {
            let now = now_millis();
            conn.execute(
                "UPDATE sync_peers SET
                    name = COALESCE(?2, name),
                    last_address = COALESCE(?3, last_address),
                    last_seen_at = CASE WHEN ?4 THEN ?6 ELSE last_seen_at END,
                    last_sync_at = CASE WHEN ?5 THEN ?6 ELSE last_sync_at END,
                    last_error = ?7
                 WHERE device_id = ?1",
                params![device_id, name, address, reached, synced, now, error],
            )?;
            if let Some(name) = name {
                name_known_device(conn, device_id, name)?;
            }
            Ok(PeerOutcome::Unit)
        }
    }
}

fn peer_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<PeerRecord> {
    Ok(PeerRecord {
        device_id: r.get(0)?,
        name: r.get(1)?,
        cert_fingerprint: r.get(2)?,
        last_address: r.get(3)?,
        paired_at: r.get(4)?,
        last_seen_at: r.get(5)?,
        last_sync_at: r.get(6)?,
        last_error: r.get(7)?,
    })
}

const PEER_COLUMNS: &str = "device_id, name, cert_fingerprint, last_address, paired_at,
     last_seen_at, last_sync_at, last_error";

/// Every paired peer, by name.
pub fn list_peers(conn: &Connection) -> Result<Vec<PeerRecord>, WorkspaceError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {PEER_COLUMNS} FROM sync_peers ORDER BY name COLLATE NOCASE, device_id"
    ))?;
    let rows = stmt.query_map([], peer_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The paired peer whose device id AND pinned fingerprint match, if any:
/// the server's authorization check.
pub fn find_authorized(
    conn: &Connection,
    device_id: &str,
    fingerprint: &str,
) -> Result<Option<PeerRecord>, WorkspaceError> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {PEER_COLUMNS} FROM sync_peers
                 WHERE device_id = ?1 AND cert_fingerprint = ?2"
            ),
            params![device_id, fingerprint],
            peer_from_row,
        )
        .optional()?)
}

/// Relative file names of the asset rows carrying `sha256`, for serving and
/// for placing a fetched blob.
pub fn asset_files_for_hash(
    conn: &Connection,
    sha256: &str,
) -> Result<Vec<String>, WorkspaceError> {
    let mut stmt =
        conn.prepare("SELECT DISTINCT file_path FROM assets WHERE sha256 = ?1 ORDER BY file_path")?;
    let rows = stmt.query_map([sha256], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Boards whose rendering shows an asset with one of `hashes` (image, embed
/// and file cards, board covers on the board itself and its parent's
/// portal): the boards to reload once fetched blobs landed.
pub fn boards_showing_hashes(
    conn: &Connection,
    hashes: &[String],
) -> Result<Vec<String>, WorkspaceError> {
    if hashes.is_empty() {
        return Ok(Vec::new());
    }
    let marks = vec!["?"; hashes.len()].join(", ");
    let sql = format!(
        "WITH a(id) AS (SELECT id FROM assets WHERE sha256 IN ({marks}))
         SELECT board_id FROM cards WHERE id IN (
             SELECT card_id FROM image_cards WHERE asset_id IN a
             UNION SELECT card_id FROM embed_cards
                 WHERE asset_id IN a OR favicon_asset_id IN a
             UNION SELECT card_id FROM file_cards
                 WHERE asset_id IN a OR preview_asset_id IN a)
         UNION SELECT id FROM boards WHERE cover_asset_id IN a
         UNION SELECT parent_board_id FROM boards
             WHERE cover_asset_id IN a AND parent_board_id IS NOT NULL"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(hashes.iter()), |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}
