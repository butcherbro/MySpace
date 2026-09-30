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
use std::future::Future;
use std::io::Read;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use http_body_util::{BodyExt, Either, Full, Limited};
use hyper::body::{Body, Bytes, Frame, Incoming, SizeHint};
use hyper::header::{HeaderValue, CONTENT_TYPE};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
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
/// A write to a peer that makes no progress this long drops the connection.
/// A stalled connection holds only an async task, so the limit can be
/// generous: a receiver pausing (antivirus on the partial file, a disk spinning
/// up) must not restart a large blob from zero. Same as the client's
/// request timeout.
const WRITE_STALL_TIMEOUT: Duration = Duration::from_secs(30);
/// A blob is sent in frames of at most this many bytes.
const BLOB_CHUNK: usize = 64 * 1024;

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
                    .serve_connection(
                        TokioIo::new(StallGuard::new(tls, WRITE_STALL_TIMEOUT)),
                        service,
                    );
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

type Resp = Response<Either<Full<Bytes>, BlobBody>>;

fn status(code: StatusCode, message: &str) -> Resp {
    let mut resp = Response::new(Either::Left(Full::new(Bytes::from(
        serde_json::json!({ "error": message }).to_string(),
    ))));
    *resp.status_mut() = code;
    resp.headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    resp
}

fn json<T: Serialize>(value: &T) -> Resp {
    match serde_json::to_vec(value) {
        Ok(body) => {
            let mut resp = Response::new(Either::Left(Full::new(Bytes::from(body))));
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

// Ответ об ошибке в Box: Response весит 144 байта и раздувает каждый Result (clippy::result_large_err).
async fn read_json<T: for<'de> Deserialize<'de>>(req: Request<Incoming>) -> Result<T, Box<Resp>> {
    let body = Limited::new(req.into_body(), MAX_JSON_BODY)
        .collect()
        .await
        .map_err(|_| {
            Box::new(status(
                StatusCode::PAYLOAD_TOO_LARGE,
                "body too large or unreadable",
            ))
        })?
        .to_bytes();
    serde_json::from_slice(&body)
        .map_err(|_| Box::new(status(StatusCode::BAD_REQUEST, "invalid json")))
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
                Err(resp) => return *resp,
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
            let mut resp = Response::new(Either::Left(Full::new(Bytes::new())));
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
    let opened = tokio::task::spawn_blocking(move || {
        files
            .iter()
            .filter(|f| crate::is_safe_asset_name(f))
            .find_map(|f| {
                let file = std::fs::File::open(assets_dir.join(f)).ok()?;
                let meta = file.metadata().ok()?;
                meta.is_file().then(|| BlobBody::new(file, meta.len()))
            })
    })
    .await
    .ok()
    .flatten();
    match opened {
        Some(body) => {
            let mut resp = Response::new(Either::Right(body));
            resp.headers_mut().insert(
                CONTENT_TYPE,
                HeaderValue::from_static("application/octet-stream"),
            );
            resp
        }
        None => status(StatusCode::NOT_FOUND, "blob not held"),
    }
}

/// A blob answer streamed from disk, [`BLOB_CHUNK`] bytes per frame. Each
/// chunk is one short blocking read: nothing holds a blocking thread while
/// the peer is slow to take the next frame. The exact length makes hyper send
/// `Content-Length`, so a file that ends early is a broken transfer, not EOF.
struct BlobBody {
    /// `None` while a read is in flight.
    file: Option<std::fs::File>,
    reading: Option<tokio::task::JoinHandle<(std::fs::File, std::io::Result<Bytes>)>>,
    remaining: u64,
}

impl BlobBody {
    fn new(file: std::fs::File, len: u64) -> Self {
        Self {
            file: Some(file),
            reading: None,
            remaining: len,
        }
    }
}

impl Body for BlobBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let this = self.get_mut();
        if this.remaining == 0 {
            return Poll::Ready(None);
        }
        if this.reading.is_none() {
            let Some(mut file) = this.file.take() else {
                return Poll::Ready(None);
            };
            let want = this.remaining.min(BLOB_CHUNK as u64) as usize;
            this.reading = Some(tokio::task::spawn_blocking(move || {
                let mut buf = vec![0; want];
                let read = loop {
                    match file.read(&mut buf) {
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        other => break other,
                    }
                };
                let chunk = read.map(|n| {
                    buf.truncate(n);
                    Bytes::from(buf)
                });
                (file, chunk)
            }));
        }
        let reading = this.reading.as_mut().expect("a read is in flight");
        let joined = std::task::ready!(Pin::new(reading).poll(cx));
        this.reading = None;
        let chunk = match joined {
            Ok((file, chunk)) => {
                this.file = Some(file);
                chunk
            }
            Err(e) => Err(std::io::Error::other(e)),
        };
        Poll::Ready(Some(match chunk {
            Ok(bytes) if bytes.is_empty() => Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "blob file shorter than its length",
            )),
            Ok(bytes) => {
                this.remaining -= bytes.len() as u64;
                Ok(Frame::data(bytes))
            }
            Err(e) => Err(e),
        }))
    }

    fn is_end_stream(&self) -> bool {
        self.remaining == 0
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.remaining)
    }
}

/// Fails a write that makes no progress for `limit`: a peer that stops
/// reading without closing must not pin its connection and response forever.
struct StallGuard<T> {
    inner: T,
    limit: Duration,
    stalled: Option<Pin<Box<tokio::time::Sleep>>>,
}

impl<T> StallGuard<T> {
    fn new(inner: T, limit: Duration) -> Self {
        Self {
            inner,
            limit,
            stalled: None,
        }
    }

    fn watch<R>(
        &mut self,
        cx: &mut Context<'_>,
        poll: Poll<std::io::Result<R>>,
    ) -> Poll<std::io::Result<R>> {
        if poll.is_ready() {
            self.stalled = None;
            return poll;
        }
        let limit = self.limit;
        let stalled = self
            .stalled
            .get_or_insert_with(|| Box::pin(tokio::time::sleep(limit)));
        if stalled.as_mut().poll(cx).is_ready() {
            self.stalled = None;
            return Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "peer stopped reading",
            )));
        }
        Poll::Pending
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for StallGuard<T> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_read(cx, buf)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for StallGuard<T> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        let poll = Pin::new(&mut this.inner).poll_write(cx, buf);
        this.watch(cx, poll)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        let poll = Pin::new(&mut this.inner).poll_write_vectored(cx, bufs);
        this.watch(cx, poll)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        let poll = Pin::new(&mut this.inner).poll_flush(cx);
        this.watch(cx, poll)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        let poll = Pin::new(&mut this.inner).poll_shutdown(cx);
        this.watch(cx, poll)
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
        Err(resp) => return *resp,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::WorkspacePaths;
    use crate::domain::asset_service;
    use sha2::{Digest, Sha256};

    struct NoHooks;

    impl ServerHooks for NoHooks {
        fn paired(&self, _device_id: &str) {}
        fn poked(&self, _device_id: &str) {}
    }

    /// A server state over a fresh workspace holding one asset with `bytes`.
    struct Fixture {
        state: ServerState,
        asset: crate::domain::models::AssetDto,
        dir: std::path::PathBuf,
    }

    impl Fixture {
        async fn new(bytes: &[u8]) -> Self {
            let dir = std::env::temp_dir().join(format!("myspace-blob-{}", uuid::Uuid::now_v7()));
            let ws = Workspace::open(WorkspacePaths::new(&dir)).unwrap();
            let staged = asset_service::stage_asset_bytes(
                &ws.paths().assets_dir(),
                "big.bin",
                "application/octet-stream",
                bytes,
            )
            .unwrap();
            ws.apply(Mutation::InsertAsset(staged.asset.clone()))
                .await
                .unwrap();
            let identity = match ws
                .apply(Mutation::SyncPeers(PeerWrite::EnsureTransportIdentity))
                .await
                .unwrap()
                .into_peer_outcome()
                .unwrap()
            {
                peers::PeerOutcome::Identity(identity) => identity,
                peers::PeerOutcome::Unit => unreachable!(),
            };
            let state = ServerState {
                ws,
                identity,
                pairing: Mutex::new(PairingWindow::default()),
                hooks: Arc::new(NoHooks),
                port: 0,
            };
            Self {
                state,
                asset: staged.asset,
                dir,
            }
        }

        fn sha(&self) -> String {
            self.asset.sha256.clone().unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn big_bytes() -> Vec<u8> {
        (0..32usize << 20).map(|i| (i % 251) as u8).collect()
    }

    /// Reads a whole body: (bytes, largest frame, sha256 hex).
    async fn drain<B>(mut body: B) -> (usize, usize, String)
    where
        B: Body<Data = Bytes> + Unpin,
        B::Error: std::fmt::Debug,
    {
        let (mut total, mut largest) = (0, 0);
        let mut hasher = Sha256::new();
        while let Some(frame) = body.frame().await {
            let data = frame.unwrap().into_data().unwrap();
            total += data.len();
            largest = largest.max(data.len());
            hasher.update(&data);
        }
        (total, largest, format!("{:x}", hasher.finalize()))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_large_blob_is_served_from_disk_in_bounded_frames() {
        let bytes = big_bytes();
        let fixture = Fixture::new(&bytes).await;
        let resp = blob(&fixture.state, &fixture.sha()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body();
        assert_eq!(
            body.size_hint().exact(),
            Some(bytes.len() as u64),
            "no exact length: no Content-Length"
        );

        let (total, largest, sha) = drain(body).await;
        assert_eq!(total, bytes.len());
        assert_eq!(sha, fixture.sha());
        assert!(largest <= 1 << 20, "a {largest}-byte frame: not streamed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_unreadable_candidate_falls_through_to_the_next_file() {
        let fixture = Fixture::new(b"the real bytes").await;
        // A second row for the same hash, sorted first, whose "file" is a directory.
        let mut shadow = fixture.asset.clone();
        shadow.id = uuid::Uuid::now_v7().to_string();
        shadow.file_path = format!("0{}", fixture.asset.file_path);
        std::fs::create_dir(
            fixture
                .state
                .ws
                .paths()
                .assets_dir()
                .join(&shadow.file_path),
        )
        .unwrap();
        fixture
            .state
            .ws
            .apply(Mutation::InsertAsset(shadow))
            .await
            .unwrap();

        let resp = blob(&fixture.state, &fixture.sha()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let (_, _, sha) = drain(resp.into_body()).await;
        assert_eq!(sha, fixture.sha());
    }

    #[test]
    fn a_stalled_transfer_holds_no_blocking_thread() {
        // One blocking thread in the whole runtime: if the unread body keeps
        // it, nothing else that needs one (pooled reads) ever runs again.
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let fixture = Fixture::new(&big_bytes()).await;
            let mut body = blob(&fixture.state, &fixture.sha()).await.into_body();
            body.frame().await.unwrap().unwrap();
            // The peer stops reading: the body is not polled any more.
            tokio::time::sleep(Duration::from_millis(200)).await;
            let other =
                tokio::time::timeout(Duration::from_secs(2), tokio::task::spawn_blocking(|| ()))
                    .await;
            assert!(other.is_ok(), "the unread body holds the blocking thread");
            drop(body);
        });
    }

    #[tokio::test]
    async fn a_write_that_makes_no_progress_times_out() {
        use tokio::io::AsyncWriteExt;
        // The far end never reads: the 1 KiB pipe fills and writes stall.
        let (near, _far) = tokio::io::duplex(1024);
        let mut guarded = StallGuard::new(near, Duration::from_millis(200));
        let write =
            tokio::time::timeout(Duration::from_secs(2), guarded.write_all(&[0u8; 64 * 1024]))
                .await
                .expect("the stalled write was never cut off");
        assert_eq!(write.unwrap_err().kind(), std::io::ErrorKind::TimedOut);
    }

    /// A stream whose shutdown never completes (a peer that stopped reading
    /// the TLS close_notify).
    struct StuckShutdown;

    impl AsyncWrite for StuckShutdown {
        fn poll_write(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            Poll::Ready(Ok(buf.len()))
        }

        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Pending
        }
    }

    #[tokio::test]
    async fn a_shutdown_that_makes_no_progress_times_out() {
        use tokio::io::AsyncWriteExt;
        let mut guarded = StallGuard::new(StuckShutdown, Duration::from_millis(200));
        let shutdown = tokio::time::timeout(Duration::from_secs(2), guarded.shutdown())
            .await
            .expect("the stalled shutdown was never cut off");
        assert_eq!(shutdown.unwrap_err().kind(), std::io::ErrorKind::TimedOut);
    }
}
