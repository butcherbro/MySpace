//! Client half of the LAN transport (ADR-0011 S3): talks to one peer's
//! server (`server.rs`) over mutual TLS with the peer's certificate pinned.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use reqwest::StatusCode;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::domain::errors::WorkspaceError;

use super::journal::ChangePage;
use super::pairing::{self, PairMessage};
use super::peers::TransportIdentity;
use super::server::{ChangesRequest, PairEnvelope, PeerInfo, DEVICE_HEADER};
use super::tls::{self, PairingServerVerifier, PinnedServerVerifier};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Blobs can be large; the timeout covers the whole transfer.
const BLOB_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Largest JSON answer accepted (one page of journal rows).
const MAX_JSON_ANSWER: usize = 256 * 1024 * 1024;

fn sync_err(message: impl Into<String>) -> WorkspaceError {
    WorkspaceError::Sync(message.into())
}

fn transport_err(e: reqwest::Error) -> WorkspaceError {
    // `{:#}`-style chain: reqwest's own message is terse ("error sending request").
    let mut message = e.to_string();
    let mut source = std::error::Error::source(&e);
    while let Some(inner) = source {
        message.push_str(": ");
        message.push_str(&inner.to_string());
        source = inner.source();
    }
    sync_err(message)
}

fn http_client(
    identity: &TransportIdentity,
    verifier: Arc<dyn rustls::client::danger::ServerCertVerifier>,
) -> Result<reqwest::Client, WorkspaceError> {
    let config = tls::client_config(identity, verifier)?;
    reqwest::Client::builder()
        .tls_backend_preconfigured(config)
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .pool_idle_timeout(Duration::from_secs(30))
        .build()
        .map_err(transport_err)
}

fn base_url(addr: SocketAddr) -> String {
    format!("https://{addr}")
}

async fn read_json<T: for<'de> serde::Deserialize<'de>>(
    resp: reqwest::Response,
) -> Result<T, WorkspaceError> {
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
            .unwrap_or_default();
        return Err(sync_err(match status {
            StatusCode::FORBIDDEN => format!("refused by the peer (403) {detail}")
                .trim()
                .to_string(),
            _ => format!("peer answered {status} {detail}")
                .trim()
                .to_string(),
        }));
    }
    if resp
        .content_length()
        .is_some_and(|len| len as usize > MAX_JSON_ANSWER)
    {
        return Err(sync_err("peer answer too large"));
    }
    let bytes = resp.bytes().await.map_err(transport_err)?;
    serde_json::from_slice(&bytes).map_err(|e| sync_err(format!("invalid answer: {e}")))
}

/// A connection to one paired peer.
pub struct PeerClient {
    http: reqwest::Client,
    base: String,
    own_device_id: String,
}

impl PeerClient {
    /// A client that accepts only `peer_fingerprint` and presents this
    /// device's certificate.
    pub fn pinned(
        identity: &TransportIdentity,
        peer_fingerprint: &str,
        addr: SocketAddr,
    ) -> Result<Self, WorkspaceError> {
        Ok(Self {
            http: http_client(identity, PinnedServerVerifier::new(peer_fingerprint))?,
            base: base_url(addr),
            own_device_id: identity.device_id.clone(),
        })
    }

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.http
            .get(format!("{}{path}", self.base))
            .header(DEVICE_HEADER, &self.own_device_id)
            .timeout(REQUEST_TIMEOUT)
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.http
            .post(format!("{}{path}", self.base))
            .header(DEVICE_HEADER, &self.own_device_id)
            .timeout(REQUEST_TIMEOUT)
    }

    pub async fn info(&self) -> Result<PeerInfo, WorkspaceError> {
        read_json(self.get("/v1/info").send().await.map_err(transport_err)?).await
    }

    pub async fn cursors(&self) -> Result<BTreeMap<String, String>, WorkspaceError> {
        read_json(
            self.get("/v1/cursors")
                .send()
                .await
                .map_err(transport_err)?,
        )
        .await
    }

    pub async fn changes(
        &self,
        cursors: &BTreeMap<String, String>,
        limit: usize,
    ) -> Result<ChangePage, WorkspaceError> {
        let body = serde_json::to_vec(&ChangesRequest {
            cursors: cursors.clone(),
            limit: Some(limit),
        })
        .map_err(|e| sync_err(e.to_string()))?;
        read_json(
            self.post("/v1/changes")
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body)
                .send()
                .await
                .map_err(transport_err)?,
        )
        .await
    }

    /// "I have new rows": asks the peer to pull from us now. Best effort.
    pub async fn poke(&self) -> Result<(), WorkspaceError> {
        let resp = self
            .post("/v1/poke")
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(transport_err)?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(sync_err(format!("poke answered {}", resp.status())))
        }
    }

    /// Downloads blob `sha256` into `dest`, which must not exist yet (never
    /// truncates a file another name may share, such as a backup hard link),
    /// verifying the hash while streaming. `Ok(false)`: the peer does not
    /// hold it (404). On any failure `dest` is removed.
    pub async fn fetch_blob(&self, sha256: &str, dest: &Path) -> Result<bool, WorkspaceError> {
        let result = self.fetch_blob_inner(sha256, dest).await;
        if !matches!(result, Ok(true)) {
            let _ = tokio::fs::remove_file(dest).await;
        }
        result
    }

    async fn fetch_blob_inner(&self, sha256: &str, dest: &Path) -> Result<bool, WorkspaceError> {
        let mut resp = self
            .get(&format!("/v1/blobs/{sha256}"))
            .timeout(BLOB_TIMEOUT)
            .send()
            .await
            .map_err(transport_err)?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(false);
        }
        if !resp.status().is_success() {
            return Err(sync_err(format!("blob answered {}", resp.status())));
        }
        let io = |e: std::io::Error| sync_err(format!("cannot write blob: {e}"));
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dest)
            .await
            .map_err(io)?;
        let mut hasher = Sha256::new();
        while let Some(chunk) = resp.chunk().await.map_err(transport_err)? {
            hasher.update(&chunk);
            file.write_all(&chunk).await.map_err(io)?;
        }
        file.flush().await.map_err(io)?;
        file.sync_all().await.map_err(io)?;
        drop(file);
        let got = pairing::hex_lower(&hasher.finalize());
        if got != sha256 {
            return Err(sync_err(format!(
                "blob {sha256} failed verification (got {got})"
            )));
        }
        Ok(true)
    }
}

/// What a successful pairing learned about the other device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairedPeer {
    pub device_id: String,
    pub name: String,
    pub fingerprint: String,
    /// The other device's server address, when it told us its port.
    pub address: Option<SocketAddr>,
}

/// The initiating side of pairing (device B, who typed A's code): see
/// `pairing.rs`. Tries `addrs` in order until one answers `GET /pair`, then
/// runs the handshake there; returns the peer and the address used.
/// `expected_fp`/`expected_device` come from the mDNS advert when pairing
/// with a discovered device.
pub async fn pair(
    identity: &TransportIdentity,
    own_name: &str,
    own_port: u16,
    addrs: &[SocketAddr],
    code: &str,
    expected_fp: Option<&str>,
    expected_device: Option<&str>,
) -> Result<(PairedPeer, SocketAddr), WorkspaceError> {
    let mut last_error = sync_err("no address to try");
    for addr in addrs {
        // A fresh verifier per address: each attempt pins its own server.
        let verifier = PairingServerVerifier::new(expected_fp);
        let http = http_client(identity, verifier.clone())?;
        let base = base_url(*addr);
        // 1. Handshake + public info: learns (and from now on pins, for this
        //    attempt) the certificate the proofs will bind.
        let hello: PeerInfo = match http
            .get(format!("{base}/pair"))
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
        {
            Ok(resp) => match read_json(resp).await {
                Ok(hello) => hello,
                Err(e) => {
                    last_error = e;
                    continue;
                }
            },
            Err(e) => {
                last_error = transport_err(e);
                continue;
            }
        };
        let peer = pair_at(
            identity,
            own_name,
            own_port,
            &http,
            &verifier,
            &base,
            hello,
            code,
            expected_device,
        )
        .await?;
        let address = peer.address.unwrap_or(*addr);
        return Ok((
            PairedPeer {
                address: Some(address),
                ..peer
            },
            *addr,
        ));
    }
    Err(last_error)
}

#[allow(clippy::too_many_arguments)]
async fn pair_at(
    identity: &TransportIdentity,
    own_name: &str,
    own_port: u16,
    http: &reqwest::Client,
    verifier: &PairingServerVerifier,
    base: &str,
    hello: PeerInfo,
    code: &str,
    expected_device: Option<&str>,
) -> Result<PairedPeer, WorkspaceError> {
    let server_fp = verifier
        .seen()
        .ok_or_else(|| sync_err("no server certificate seen"))?;
    if hello.device_id == identity.device_id {
        return Err(sync_err("that address is this device"));
    }
    if expected_device.is_some_and(|d| d != hello.device_id) {
        return Err(sync_err("a different device answered at that address"));
    }

    // 2. Our proof, their proof.
    let request = PairEnvelope {
        message: PairMessage {
            device_id: identity.device_id.clone(),
            name: own_name.to_string(),
            fingerprint: identity.fingerprint.clone(),
            proof: pairing::proof(code, &identity.fingerprint, &server_fp),
        },
        port: Some(own_port),
    };
    let resp = http
        .post(format!("{base}/pair"))
        .timeout(REQUEST_TIMEOUT)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::to_vec(&request).map_err(|e| sync_err(e.to_string()))?)
        .send()
        .await
        .map_err(transport_err)?;
    match resp.status() {
        StatusCode::FORBIDDEN => return Err(sync_err("wrong code")),
        StatusCode::GONE => {
            return Err(sync_err(
                "the other device is not showing a pairing code (or it expired)",
            ))
        }
        StatusCode::TOO_MANY_REQUESTS => {
            return Err(sync_err(
                "wrong code; too many attempts, start pairing again on the other device",
            ))
        }
        _ => {}
    }
    let answer: PairEnvelope = read_json(resp).await?;
    let answer_fp = answer.message.fingerprint.to_ascii_lowercase();
    if verifier.seen().as_deref() != Some(server_fp.as_str()) || answer_fp != server_fp {
        return Err(sync_err(
            "the other device's certificate does not match its answer",
        ));
    }
    if answer.message.device_id != hello.device_id {
        return Err(sync_err("the other device changed identity during pairing"));
    }
    if !pairing::verify_proof(
        code,
        &server_fp,
        &identity.fingerprint,
        &answer.message.proof,
    ) {
        return Err(sync_err(
            "the other device could not prove it knows the code",
        ));
    }
    let name = crate::domain::device::normalize_device_name(&answer.message.name)
        .unwrap_or_else(|_| hello.name.clone());
    let ip = base
        .trim_start_matches("https://")
        .parse::<SocketAddr>()
        .map(|a| a.ip())
        .ok();
    Ok(PairedPeer {
        device_id: answer.message.device_id,
        name,
        fingerprint: server_fp,
        address: ip
            .zip(answer.port)
            .map(|(ip, port)| SocketAddr::new(ip, port)),
    })
}
