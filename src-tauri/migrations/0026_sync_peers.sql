-- 0026_sync_peers.sql
-- Device sync S3 (ADR-0011): paired LAN peers. LOCAL-ONLY
-- (`LOCAL_ONLY_TABLES`): who this device trusts is its own decision and is
-- never journaled or exchanged.
--
--   device_id         the peer's `device_id` (ADR-0012).
--   name              the peer's device name, refreshed from `/v1/info`.
--   cert_fingerprint  lowercase hex SHA-256 of the peer's self-signed TLS
--                     certificate (DER): the pinned transport identity. A
--                     request is accepted only when the client certificate
--                     presented in the TLS handshake hashes to this value.
--   last_address      `host:port` that last worked (or was typed when pairing
--                     by address), used when mDNS does not see the peer.
--   paired_at, last_seen_at, last_sync_at   unix milliseconds.
--   last_error        the last sync failure with this peer, NULL after a
--                     successful pass.
CREATE TABLE sync_peers (
    device_id        TEXT PRIMARY KEY NOT NULL,
    name             TEXT NOT NULL,
    cert_fingerprint TEXT NOT NULL UNIQUE,
    last_address     TEXT,
    paired_at        INTEGER NOT NULL,
    last_seen_at     INTEGER,
    last_sync_at     INTEGER,
    last_error       TEXT
);
