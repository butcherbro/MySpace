//! The LAN sync server (ADR-0011 S3): HTTPS (TLS 1.3, mutual) over hyper,
//! JSON bodies. Every device runs one; peers PULL from it.
//!
//! | Route                  | Auth          | Answer                                  |
//! |------------------------|---------------|-----------------------------------------|
//! | `GET  /pair`           | any client cert | `{deviceId, name, fingerprint}` (public, same as the mDNS advert) |
//! | `POST /pair`           | any client cert | pairing handshake (`pairing.rs`)      |
//! | `GET  /v1/info`        | paired peer   | `{deviceId, name, protocol: 1}`         |
//! | `GET  /v1/cursors`     | paired peer   | this device's cursors                   |
//! | `POST /v1/changes`     | paired peer   | `{cursors, limit}` → `{rows, next}`     |
//! | `GET  /v1/blobs/{sha}` | paired peer   | asset bytes, or 404                     |
//! | `POST /v1/poke`        | paired peer   | 204; "I have new rows, pull now"        |
//!
//! "Paired peer" = the request's `X-MySpace-Device` header names a
//! `sync_peers` row whose pinned fingerprint equals the SHA-256 of the client
//! certificate presented in the TLS handshake; otherwise 403.

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::{HeaderValue, CONTENT_TYPE};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_rustls::TlsAcceptor;

use crate::app::Workspace;
use crate::domain::errors::WorkspaceError;
use crate::domain::mutation::Mutation;

use super::journal;
use super::pairing::{self, PairMessage, PairRefusal, PairingWindow};
use super::peers::{self, PeerWrite, TransportIdentity};
use super::tls;

/// Wire protocol version (`/v1/info`).
pub const PROTOCOL_VERSION: u32 = 1;
/// Header naming the requesting device.
pub const DEVICE_HEADER: &str = "x-myspace-device";

const MAX_JSON_BODY: usize = 1024 * 1024;
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// `GET /v1/info` and `GET /pair`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfo {
    pub device_id: String,
    pub name: String,
    #[serde(default)]
    pub protocol: u32,
    #[serde(default)]
    pub fingerprint: Option<String>,
}

/// `POST /v1/changes` body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesRequest {
    pub cursors: BTreeMap<String, String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

/// `POST /pair` body and answer: [`PairMessage`] plus the sender's server
/// port, so the side that answered can reach the other one without mDNS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairEnvelope {
    #[serde(flatten)]
    pub message: PairMessage,
    #[serde(default)]
    pub port: Option<u16>,
}

/// What the server tells its owner (the LAN sync service).
pub trait ServerHooks: Send + Sync {
    /// A device paired with us through `/pair`.
    fn paired(&self, device_id: &str);
    /// A paired peer has new rows (`/v1/poke`).
    fn poked(&self, device_id: &str);
}

/// Shared state of the server.
pub struct ServerState {
    pub ws: Workspace,
    pub identity: TransportIdentity,
    pub pairing: Mutex<PairingWindow>,
    pub hooks: Arc<dyn ServerHooks>,
    pub port: u16,
}

/// A running server; dropping the handle does not stop it, [`stop`] does.
///
/// [`stop`]: ServerHandle::stop
pub struct ServerHandle {
    pub local_addr: SocketAddr,
    shutdown: watch::Sender<bool>,
}

impl ServerHandle {
    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
    }
}

/// Binds `bind` and serves until stopped. The state's `port` must be set by
/// the caller from [`bind_listener`]'s result.
pub async fn bind_listener(bind: SocketAddr) -> Result<TcpListener, WorkspaceError> {
    TcpListener::bind(bind)
        .await
        .map_err(|e| WorkspaceError::Sync(format!("cannot listen on {bind}: {e}")))
}

/// Serves `listener` with `state` on the current tokio runtime.
pub fn spawn(
    listener: TcpListener,
    state: Arc<ServerState>,
) -> Result<ServerHandle, WorkspaceError> {
    let local_addr = listener
        .local_addr()
        .map_err(|e| WorkspaceError::Sync(format!("listener address: {e}")))?;
    let acceptor = TlsAcceptor::from(Arc::new(tls::server_config(&state.identity)?));
    let (shutdown, mut stopped) = watch::channel(false);
    tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                accepted = listener.accept() => accepted,
                _ = stopped.changed() => break,
            };
            let (tcp, remote) = match accepted {
                Ok(pair) => pair,
                Err(error) => {
                    tracing::warn!(%error, "sync server: accept failed");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            let acceptor = acceptor.clone();
            let state = state.clone();
            let mut conn_stopped = stopped.clone();
            tokio::spawn(async move {
                let tls =
                    match tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(tcp)).await {
                        Ok(Ok(tls)) => tls,
                        Ok(Err(error)) => {
                            tracing::debug!(%error, %remote, "sync server: TLS handshake refused");
                            return;
                        }
                        Err(_) => return,
                    };
                let Some(client_fp) = tls
                    .get_ref()
                    .1
                    .peer_certificates()
                    .and_then(|certs| certs.first())
                    .map(|cert| tls::fingerprint(cert))
                else {
                    return;
                };
                let service = service_fn(move |req| {
                    let state = state.clone();
                    let client_fp = client_fp.clone();
                    async move { Ok::<_, Infallible>(handle(&state, &client_fp, remote, req).await) }
                });
                let conn = http1::Builder::new()
                    .timer(TokioTimer::new())
                    .header_read_timeout(HEADER_READ_TIMEOUT)
                    .serve_connection(TokioIo::new(tls), service);
                tokio::pin!(conn);
                tokio::select! {
                    _ = conn.as_mut() => {}
                    _ = conn_stopped.changed() => {
                        conn.as_mut().graceful_shutdown();
                        let _ = conn.await;
                    }
                }
            });
        }
    });
    Ok(ServerHandle {
        local_addr,
        shutdown,
    })
}

type Resp = Response<Full<Bytes>>;

fn status(code: StatusCode, message: &str) -> Resp {
    let mut resp = Response::new(Full::new(Bytes::from(
        serde_json::json!({ "error": message }).to_string(),
    )));
    *resp.status_mut() = code;
    resp.headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    resp
}

fn json<T: Serialize>(value: &T) -> Resp {
    match serde_json::to_vec(value) {
        Ok(body) => {
            let mut resp = Response::new(Full::new(Bytes::from(body)));
            resp.headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
            resp
        }
        Err(_) => status(StatusCode::INTERNAL_SERVER_ERROR, "encode"),
    }
}

fn internal(error: WorkspaceError) -> Resp {
    tracing::warn!(
        error_code = crate::telemetry::ErrorCode::code(&error),
        "sync server: request failed"
    );
    status(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

async fn read_json<T: for<'de> Deserialize<'de>>(req: Request<Incoming>) -> Result<T, Resp> {
    let body = Limited::new(req.into_body(), MAX_JSON_BODY)
        .collect()
        .await
        .map_err(|_| {
            status(
                StatusCode::PAYLOAD_TOO_LARGE,
                "body too large or unreadable",
            )
        })?
        .to_bytes();
    serde_json::from_slice(&body).map_err(|_| status(StatusCode::BAD_REQUEST, "invalid json"))
}

async fn own_name(ws: &Workspace) -> Result<String, WorkspaceError> {
    ws.read(|c| Ok(crate::repositories::devices::load_device_identity(c)?.device_name))
        .await
}

async fn handle(
    state: &ServerState,
    client_fp: &str,
    remote: SocketAddr,
    req: Request<Incoming>,
) -> Resp {
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    match (&method, path.as_str()) {
        (&Method::GET, "/pair") => match own_name(&state.ws).await {
            Ok(name) => json(&PeerInfo {
                device_id: state.identity.device_id.clone(),
                name,
                protocol: PROTOCOL_VERSION,
                fingerprint: Some(state.identity.fingerprint.clone()),
            }),
            Err(e) => internal(e),
        },
        (&Method::POST, "/pair") => pair(state, client_fp, remote, req).await,
        _ if path.starts_with("/v1/") => {
            let device = req
                .headers()
                .get(DEVICE_HEADER)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let fp = client_fp.to_string();
            let authorized = state
                .ws
                .read(move |c| peers::find_authorized(c, &device, &fp))
                .await;
            let peer = match authorized {
                Ok(Some(peer)) => peer,
                Ok(None) => return status(StatusCode::FORBIDDEN, "not a paired device"),
                Err(e) => return internal(e),
            };
            v1(state, &peer.device_id, &method, &path, req).await
        }
        _ => status(StatusCode::NOT_FOUND, "no such route"),
    }
}

async fn v1(
    state: &ServerState,
    peer: &str,
    method: &Method,
    path: &str,
    req: Request<Incoming>,
) -> Resp {
    match (method, path) {
        (&Method::GET, "/v1/info") => match own_name(&state.ws).await {
            Ok(name) => json(&PeerInfo {
                device_id: state.identity.device_id.clone(),
                name,
                protocol: PROTOCOL_VERSION,
                fingerprint: None,
            }),
            Err(e) => internal(e),
        },
        (&Method::GET, "/v1/cursors") => match state.ws.read(journal::our_cursors).await {
            Ok(cursors) => json(&cursors),
            Err(e) => internal(e),
        },
        (&Method::POST, "/v1/changes") => {
            let body: ChangesRequest = match read_json(req).await {
                Ok(b) => b,
                Err(resp) => return resp,
            };
            let limit = body
                .limit
                .unwrap_or(journal::DEFAULT_PAGE)
                .min(journal::MAX_PAGE);
            match state
                .ws
                .read(move |c| journal::changes_since(c, &body.cursors, limit))
                .await
            {
                Ok(page) => json(&page),
                Err(e) => internal(e),
            }
        }
        (&Method::POST, "/v1/poke") => {
            state.hooks.poked(peer);
            let mut resp = Response::new(Full::new(Bytes::new()));
            *resp.status_mut() = StatusCode::NO_CONTENT;
            resp
        }
        (&Method::GET, p) if p.starts_with("/v1/blobs/") => {
            blob(state, &p["/v1/blobs/".len()..]).await
        }
        _ => status(StatusCode::NOT_FOUND, "no such route"),
    }
}

/// True for a lowercase hex SHA-256.
pub fn is_sha256(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

async fn blob(state: &ServerState, sha: &str) -> Resp {
    if !is_sha256(sha) {
        return status(StatusCode::BAD_REQUEST, "not a sha256");
    }
    let hash = sha.to_string();
    let files = match state
        .ws
        .read(move |c| peers::asset_files_for_hash(c, &hash))
        .await
    {
        Ok(files) => files,
        Err(e) => return internal(e),
    };
    let assets_dir = state.ws.paths().assets_dir();
    let read = tokio::task::spawn_blocking(move || {
        files
            .iter()
            .filter(|f| crate::is_safe_asset_name(f))
            .find_map(|f| std::fs::read(assets_dir.join(f)).ok())
    })
    .await
    .ok()
    .flatten();
    match read {
        Some(bytes) => {
            let mut resp = Response::new(Full::new(Bytes::from(bytes)));
            resp.headers_mut().insert(
                CONTENT_TYPE,
                HeaderValue::from_static("application/octet-stream"),
            );
            resp
        }
        None => status(StatusCode::NOT_FOUND, "blob not held"),
    }
}

async fn pair(
    state: &ServerState,
    client_fp: &str,
    remote: SocketAddr,
    req: Request<Incoming>,
) -> Resp {
    let envelope: PairEnvelope = match read_json(req).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let msg = envelope.message;
    if msg.fingerprint.to_ascii_lowercase() != client_fp {
        return status(
            StatusCode::BAD_REQUEST,
            "fingerprint does not match the client certificate",
        );
    }
    if msg.device_id == state.identity.device_id || msg.device_id.trim().is_empty() {
        return status(StatusCode::BAD_REQUEST, "invalid device id");
    }
    let name = match crate::domain::device::normalize_device_name(&msg.name) {
        Ok(name) => name,
        Err(_) => return status(StatusCode::BAD_REQUEST, "invalid device name"),
    };
    let attempt = match state.pairing.lock() {
        Ok(mut window) => window.attempt(client_fp, &state.identity.fingerprint, &msg.proof),
        Err(_) => return status(StatusCode::INTERNAL_SERVER_ERROR, "pairing state"),
    };
    let code = match attempt {
        Ok(code) => code,
        Err(PairRefusal::NoActiveCode) => {
            return status(StatusCode::GONE, "no pairing code is active on this device")
        }
        Err(PairRefusal::WrongCode) => return status(StatusCode::FORBIDDEN, "wrong code"),
        Err(PairRefusal::TooManyAttempts) => {
            return status(
                StatusCode::TOO_MANY_REQUESTS,
                "wrong code; too many attempts, the code is no longer valid",
            )
        }
    };
    let address = envelope
        .port
        .map(|port| SocketAddr::new(remote.ip(), port).to_string());
    if let Err(e) = state
        .ws
        .apply(Mutation::SyncPeers(PeerWrite::Upsert {
            device_id: msg.device_id.clone(),
            name,
            fingerprint: client_fp.to_string(),
            address,
        }))
        .await
    {
        return internal(e);
    }
    state.hooks.paired(&msg.device_id);
    let own_name = match own_name(&state.ws).await {
        Ok(name) => name,
        Err(e) => return internal(e),
    };
    json(&PairEnvelope {
        message: PairMessage {
            device_id: state.identity.device_id.clone(),
            name: own_name,
            fingerprint: state.identity.fingerprint.clone(),
            proof: pairing::proof(&code, &state.identity.fingerprint, client_fp),
        },
        port: Some(state.port),
    })
}
