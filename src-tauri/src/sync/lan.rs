//! LAN sync service (ADR-0011 S3): symmetric peers, pull-based.
//!
//! Every device runs the same service: an HTTPS server (`server.rs`) that
//! serves its journal to paired peers, an mDNS advert + browser
//! (`discovery.rs`), and a loop that PULLS from every reachable paired peer
//! and applies the rows through the S2 engine (the writer funnel). Both sides
//! pull, so both converge; nothing is ever pushed.
//!
//! Triggers of a pass: startup; every [`TICK`] while a paired peer has an
//! address (discovered, or the last one that worked); [`DEBOUNCE`] after a
//! local journaled write (`Workspace::local_writes`), which also POKEs the
//! peers so they pull at once instead of on their next tick; a peer's poke;
//! `sync_now`. One pass at a time.
//!
//! A pass, per peer: `/v1/info` (identity check) → `/v1/changes` with our
//! cursors until `next` is empty, each page applied through the funnel →
//! every blob in `journal::missing_blobs` fetched from that peer, hash
//! verified, then placed under each asset row's file name → `sync_peers`
//! updated (`last_sync_at` or `last_error`).

use std::collections::{BTreeSet, HashMap};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::{watch, Notify};

use crate::app::Workspace;
use crate::db::migrations::now_millis;
use crate::domain::errors::WorkspaceError;
use crate::domain::mutation::Mutation;
use crate::repositories::devices;

use super::discovery::{Discovered, DiscoveredMap, Discovery};
use super::journal;
use super::pairing::{self, PairingWindow};
use super::peer_client::{self, PeerClient};
use super::peers::{self, PeerOutcome, PeerRecord, PeerWrite, TransportIdentity};
use super::server::{self, ServerHandle, ServerHooks, ServerState};

/// Automatic pass interval.
pub const TICK: Duration = Duration::from_secs(5);
/// Delay after a local write, so a burst of writes is one pass.
pub const DEBOUNCE: Duration = Duration::from_millis(500);
/// Rows per `/v1/changes` page.
pub const PAGE: usize = 500;
/// Longest wait between automatic attempts at an unreachable peer.
const MAX_BACKOFF: Duration = Duration::from_secs(60);

/// How the service runs.
#[derive(Debug, Clone)]
pub struct LanConfig {
    /// Server bind address. The app binds `0.0.0.0:0` (random port, all
    /// interfaces); tests bind `127.0.0.1:0`.
    pub bind: SocketAddr,
    /// Advertise and browse with mDNS.
    pub discovery: bool,
    /// Run the background loop (tests drive passes by hand).
    pub run_loop: bool,
}

impl Default for LanConfig {
    fn default() -> Self {
        Self {
            bind: SocketAddr::from(([0, 0, 0, 0], 0)),
            discovery: true,
            run_loop: true,
        }
    }
}

/// Where the service reports to (the Tauri app emits events).
pub trait SyncEvents: Send + Sync {
    /// `sync-state`.
    fn state(&self, state: &SyncState);
    /// `sync-applied`: local board ids whose content changed.
    fn applied(&self, boards: &[String]);
}

/// No-op sink (tests).
pub struct NoEvents;

impl SyncEvents for NoEvents {
    fn state(&self, _: &SyncState) {}
    fn applied(&self, _: &[String]) {}
}

/// One paired peer as the UI shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerState {
    pub device_id: String,
    pub name: String,
    /// The last contact attempt succeeded.
    pub online: bool,
    /// mDNS currently sees it.
    pub discovered: bool,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    pub last_address: Option<String>,
}

/// Payload of `sync-state` and `get_sync_state`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub peers: Vec<PeerState>,
    /// mDNS is running.
    pub discovering: bool,
    /// Why mDNS is not running, when it is not.
    pub discovery_error: Option<String>,
    /// A user-visible pass is running.
    pub syncing: bool,
    /// This device's server port and LAN addresses (for "Add by address").
    pub port: u16,
    pub addresses: Vec<String>,
}

/// A device found by mDNS, as `sync_list_discovered` returns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDevice {
    pub device_id: String,
    pub name: String,
    pub addresses: Vec<String>,
    pub fingerprint: String,
    pub paired: bool,
}

/// `sync_begin_pairing`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    pub code: String,
    /// Unix ms.
    pub expires_at: i64,
}

/// What one pass did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PassReport {
    pub peers_synced: usize,
    pub rows_received: usize,
    pub blobs_fetched: usize,
    pub touched_boards: Vec<String>,
    pub errors: Vec<(String, String)>,
}

#[derive(Debug, Clone, Default)]
struct Health {
    online: bool,
    failures: u32,
    next_try: Option<Instant>,
}

/// The running service.
pub struct LanSync {
    ws: Workspace,
    identity: TransportIdentity,
    server_state: Arc<ServerState>,
    server: ServerHandle,
    discovery: Mutex<Option<Discovery>>,
    discovery_error: Mutex<Option<String>>,
    discovered: DiscoveredMap,
    health: Mutex<HashMap<String, Health>>,
    pass_lock: tokio::sync::Mutex<()>,
    syncing: AtomicBool,
    /// Wakes the loop for a forced pass (poke, pairing, sync_now).
    wake: Arc<Notify>,
    events: Arc<dyn SyncEvents>,
    last_state: Mutex<Option<SyncState>>,
    stop: watch::Sender<bool>,
    runtime: tokio::runtime::Handle,
}

struct Hooks {
    lan: Mutex<Weak<LanSync>>,
}

impl Hooks {
    fn lan(&self) -> Option<Arc<LanSync>> {
        self.lan.lock().ok().and_then(|w| w.upgrade())
    }
}

impl ServerHooks for Hooks {
    fn paired(&self, _device_id: &str) {
        if let Some(lan) = self.lan() {
            lan.wake.notify_one();
            lan.spawn_emit();
        }
    }

    fn poked(&self, _device_id: &str) {
        if let Some(lan) = self.lan() {
            lan.wake.notify_one();
        }
    }
}

fn sync_err(message: impl Into<String>) -> WorkspaceError {
    WorkspaceError::Sync(message.into())
}

/// Non-loopback addresses of this machine (IPv4 first).
fn local_addresses() -> Vec<IpAddr> {
    let mut ips: Vec<IpAddr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback() && !i.is_link_local())
        .map(|i| i.ip())
        .collect();
    ips.sort_by_key(|ip| (!ip.is_ipv4(), *ip));
    ips.dedup();
    ips
}

impl LanSync {
    /// Mints the TLS identity if needed, binds the server, starts discovery
    /// and (per `config`) the loop. Must run inside a tokio runtime.
    pub async fn start(
        ws: Workspace,
        config: LanConfig,
        events: Arc<dyn SyncEvents>,
    ) -> Result<Arc<Self>, WorkspaceError> {
        let identity = match ws
            .apply(Mutation::SyncPeers(PeerWrite::EnsureTransportIdentity))
            .await?
            .into_peer_outcome()?
        {
            PeerOutcome::Identity(identity) => identity,
            PeerOutcome::Unit => return Err(sync_err("no transport identity")),
        };
        let listener = server::bind_listener(config.bind).await?;
        let port = listener
            .local_addr()
            .map_err(|e| sync_err(e.to_string()))?
            .port();
        let hooks = Arc::new(Hooks {
            lan: Mutex::new(Weak::new()),
        });
        let server_state = Arc::new(ServerState {
            ws: ws.clone(),
            identity: identity.clone(),
            pairing: Mutex::new(PairingWindow::default()),
            hooks: hooks.clone(),
            port,
        });
        let server = server::spawn(listener, server_state.clone())?;
        let (stop, stop_rx) = watch::channel(false);
        let lan = Arc::new(Self {
            ws,
            identity,
            server_state,
            server,
            discovery: Mutex::new(None),
            discovery_error: Mutex::new(None),
            discovered: DiscoveredMap::default(),
            health: Mutex::new(HashMap::new()),
            pass_lock: tokio::sync::Mutex::new(()),
            syncing: AtomicBool::new(false),
            wake: Arc::new(Notify::new()),
            events,
            last_state: Mutex::new(None),
            stop,
            runtime: tokio::runtime::Handle::current(),
        });
        if let Ok(mut weak) = hooks.lan.lock() {
            *weak = Arc::downgrade(&lan);
        }
        tracing::info!(
            port,
            fingerprint = %lan.identity.fingerprint,
            "sync: LAN server listening"
        );

        if config.discovery {
            lan.start_discovery().await;
        } else {
            lan.set_discovery_error(Some("discovery disabled".into()));
        }
        if config.run_loop {
            let looped = lan.clone();
            tokio::spawn(async move { looped.run_loop(stop_rx).await });
        }
        lan.emit_state().await;
        Ok(lan)
    }

    async fn start_discovery(self: &Arc<Self>) {
        let name = self.own_name().await.unwrap_or_default();
        let weak = Arc::downgrade(self);
        let runtime = self.runtime.clone();
        let on_change: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            if let Some(lan) = weak.upgrade() {
                lan.wake.notify_one();
                runtime.spawn(async move { lan.emit_state().await });
            }
        });
        match Discovery::start(
            &self.identity.device_id,
            &name,
            &self.identity.fingerprint,
            self.port(),
            self.discovered.clone(),
            on_change,
        ) {
            Ok(discovery) => {
                if let Ok(mut d) = self.discovery.lock() {
                    *d = Some(discovery);
                }
                self.set_discovery_error(None);
            }
            Err(error) => {
                tracing::warn!(%error, error_code = "sync_discovery_unavailable", "sync: mDNS unavailable");
                self.set_discovery_error(Some(format!("discovery unavailable: {error}")));
            }
        }
    }

    fn set_discovery_error(&self, error: Option<String>) {
        if let Ok(mut e) = self.discovery_error.lock() {
            *e = error;
        }
    }

    /// Stops the server, discovery and the loop.
    pub fn stop(&self) {
        let _ = self.stop.send(true);
        self.server.stop();
        if let Ok(mut d) = self.discovery.lock() {
            if let Some(discovery) = d.take() {
                discovery.stop();
            }
        }
    }

    pub fn port(&self) -> u16 {
        self.server.local_addr.port()
    }

    pub fn fingerprint(&self) -> &str {
        &self.identity.fingerprint
    }

    pub fn device_id(&self) -> &str {
        &self.identity.device_id
    }

    async fn own_name(&self) -> Result<String, WorkspaceError> {
        self.ws
            .read(|c| Ok(devices::load_device_identity(c)?.device_name))
            .await
    }

    /// Re-advertises after a rename.
    pub async fn device_renamed(self: &Arc<Self>) {
        let running = self.discovery.lock().ok().and_then(|mut d| d.take());
        if let Some(discovery) = running {
            discovery.stop();
            self.start_discovery().await;
        }
    }

    // ---- state -------------------------------------------------------------

    fn discovered_snapshot(&self) -> HashMap<String, Discovered> {
        self.discovered
            .lock()
            .map(|m| m.clone())
            .unwrap_or_default()
    }

    /// The current state (what `sync-state` carries).
    pub async fn state(&self) -> Result<SyncState, WorkspaceError> {
        let records = self.ws.read(peers::list_peers).await?;
        let discovered = self.discovered_snapshot();
        let health = self.health.lock().map(|h| h.clone()).unwrap_or_default();
        let peers = records
            .into_iter()
            .map(|p| PeerState {
                online: health.get(&p.device_id).is_some_and(|h| h.online),
                discovered: discovered
                    .get(&p.device_id)
                    .is_some_and(|d| d.fingerprint == p.cert_fingerprint),
                device_id: p.device_id,
                name: p.name,
                last_sync_at: p.last_sync_at,
                last_error: p.last_error,
                last_address: p.last_address,
            })
            .collect();
        let discovery_error = self.discovery_error.lock().ok().and_then(|e| e.clone());
        let discovering = self.discovery.lock().map(|d| d.is_some()).unwrap_or(false);
        Ok(SyncState {
            peers,
            discovering,
            discovery_error,
            syncing: self.syncing.load(Ordering::SeqCst),
            port: self.port(),
            addresses: local_addresses()
                .into_iter()
                .map(|ip| SocketAddr::new(ip, self.port()).to_string())
                .collect(),
        })
    }

    /// Emits `sync-state` when it changed since the last emit.
    pub async fn emit_state(&self) {
        let Ok(state) = self.state().await else {
            return;
        };
        let changed = match self.last_state.lock() {
            Ok(mut last) => {
                if last.as_ref() == Some(&state) {
                    false
                } else {
                    *last = Some(state.clone());
                    true
                }
            }
            Err(_) => true,
        };
        if changed {
            self.events.state(&state);
        }
    }

    fn spawn_emit(self: &Arc<Self>) {
        let lan = self.clone();
        self.runtime.spawn(async move { lan.emit_state().await });
    }

    /// Devices mDNS sees (never this one), with whether they are paired.
    pub async fn discovered(&self) -> Result<Vec<DiscoveredDevice>, WorkspaceError> {
        let records = self.ws.read(peers::list_peers).await?;
        let mut list: Vec<DiscoveredDevice> = self
            .discovered_snapshot()
            .into_values()
            .map(|d| DiscoveredDevice {
                paired: records
                    .iter()
                    .any(|p| p.device_id == d.device_id && p.cert_fingerprint == d.fingerprint),
                addresses: d.socket_addrs().iter().map(|a| a.to_string()).collect(),
                device_id: d.device_id,
                name: d.name,
                fingerprint: d.fingerprint,
            })
            .collect();
        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(list)
    }

    // ---- pairing -----------------------------------------------------------

    /// Shows a new pairing code on this device (replaces the previous one).
    pub fn begin_pairing(&self) -> Result<PairingCode, WorkspaceError> {
        let mut window = self
            .server_state
            .pairing
            .lock()
            .map_err(|_| sync_err("pairing state poisoned"))?;
        let code = window.begin(now_millis());
        Ok(PairingCode {
            code: code.code,
            expires_at: code.expires_at_ms,
        })
    }

    /// Hides the code.
    pub fn cancel_pairing(&self) {
        if let Ok(mut window) = self.server_state.pairing.lock() {
            window.cancel();
        }
    }

    /// Pairs with a discovered device (`device_id`) or an address
    /// (`host:port`), using the code the other device shows.
    pub async fn pair_with(
        self: &Arc<Self>,
        device_id: Option<&str>,
        address: Option<&str>,
        code: &str,
    ) -> Result<PeerState, WorkspaceError> {
        let code = pairing::normalize_code(code).ok_or_else(|| {
            WorkspaceError::ConstraintViolation("the pairing code has 6 digits".into())
        })?;
        let (addrs, expected_fp, expected_device) = match (device_id, address) {
            (Some(id), _) => {
                let found = self
                    .discovered_snapshot()
                    .remove(id)
                    .ok_or_else(|| sync_err("that device is no longer visible on the network"))?;
                (
                    found.socket_addrs(),
                    Some(found.fingerprint),
                    Some(id.to_string()),
                )
            }
            (None, Some(address)) => (resolve(address).await?, None, None),
            (None, None) => {
                return Err(WorkspaceError::ConstraintViolation(
                    "a device or an address is required".into(),
                ))
            }
        };
        if addrs.is_empty() {
            return Err(sync_err("no usable address for that device"));
        }
        let name = self.own_name().await?;
        let (peer, used) = peer_client::pair(
            &self.identity,
            &name,
            self.port(),
            &addrs,
            &code,
            expected_fp.as_deref(),
            expected_device.as_deref(),
        )
        .await?;
        let address = peer.address.unwrap_or(used).to_string();
        self.ws
            .apply(Mutation::SyncPeers(PeerWrite::Upsert {
                device_id: peer.device_id.clone(),
                name: peer.name.clone(),
                fingerprint: peer.fingerprint.clone(),
                address: Some(address.clone()),
            }))
            .await?;
        if let Ok(mut health) = self.health.lock() {
            health.insert(
                peer.device_id.clone(),
                Health {
                    online: true,
                    ..Health::default()
                },
            );
        }
        tracing::info!(peer = %peer.device_id, "sync: paired");
        self.wake.notify_one();
        self.emit_state().await;
        Ok(PeerState {
            device_id: peer.device_id,
            name: peer.name,
            online: true,
            discovered: expected_device.is_some(),
            last_sync_at: None,
            last_error: None,
            last_address: Some(address),
        })
    }

    /// Forgets a peer: it is refused from now on (403) and no longer pulled.
    pub async fn unpair(&self, device_id: &str) -> Result<(), WorkspaceError> {
        self.ws
            .apply(Mutation::SyncPeers(PeerWrite::Remove {
                device_id: device_id.to_string(),
            }))
            .await?;
        if let Ok(mut health) = self.health.lock() {
            health.remove(device_id);
        }
        self.emit_state().await;
        Ok(())
    }

    // ---- the loop ----------------------------------------------------------

    async fn run_loop(self: Arc<Self>, mut stop: watch::Receiver<bool>) {
        let local_writes = self.ws.local_writes();
        let mut first = true;
        loop {
            let (mut force, mut poke) = (first, false);
            if !first {
                tokio::select! {
                    _ = stop.changed() => break,
                    _ = tokio::time::sleep(TICK) => {}
                    _ = local_writes.notified() => {
                        tokio::time::sleep(DEBOUNCE).await;
                        force = true;
                        poke = true;
                    }
                    _ = self.wake.notified() => force = true,
                }
            }
            first = false;
            if *stop.borrow() {
                break;
            }
            let report = self.pass(force, poke).await;
            if !report.errors.is_empty() {
                tracing::debug!(
                    errors = report.errors.len(),
                    "sync: pass finished with errors"
                );
            }
        }
    }

    /// One pass over every paired peer, ignoring backoff (`sync_now`).
    pub async fn sync_now(&self) -> PassReport {
        self.pass(true, false).await
    }

    fn candidates(
        &self,
        peer: &PeerRecord,
        discovered: &HashMap<String, Discovered>,
    ) -> Vec<SocketAddr> {
        let mut addrs = Vec::new();
        if let Some(d) = discovered.get(&peer.device_id) {
            if d.fingerprint == peer.cert_fingerprint {
                addrs.extend(d.socket_addrs());
            }
        }
        if let Some(last) = peer.last_address.as_deref().and_then(|a| a.parse().ok()) {
            if !addrs.contains(&last) {
                addrs.push(last);
            }
        }
        addrs
    }

    fn due(&self, device_id: &str) -> bool {
        self.health
            .lock()
            .ok()
            .and_then(|h| h.get(device_id).and_then(|h| h.next_try))
            .is_none_or(|next| Instant::now() >= next)
    }

    fn record_health(&self, device_id: &str, ok: bool) {
        if let Ok(mut map) = self.health.lock() {
            let h = map.entry(device_id.to_string()).or_default();
            if ok {
                *h = Health {
                    online: true,
                    ..Health::default()
                };
            } else {
                h.online = false;
                h.failures = h.failures.saturating_add(1);
                let backoff = TICK
                    .saturating_mul(1 << h.failures.saturating_sub(1).min(4))
                    .min(MAX_BACKOFF);
                h.next_try = Some(Instant::now() + backoff);
            }
        }
    }

    /// Pulls from every reachable paired peer. `force` ignores backoff and
    /// shows "syncing"; `poke` first tells each peer we have new rows.
    pub async fn pass(&self, force: bool, poke: bool) -> PassReport {
        let _guard = self.pass_lock.lock().await;
        let mut report = PassReport::default();
        let records = match self.ws.read(peers::list_peers).await {
            Ok(records) => records,
            Err(error) => {
                report.errors.push((String::new(), error.to_string()));
                return report;
            }
        };
        if records.is_empty() {
            return report;
        }
        if force {
            self.syncing.store(true, Ordering::SeqCst);
            self.emit_state().await;
        }
        let discovered = self.discovered_snapshot();
        let mut touched: BTreeSet<String> = BTreeSet::new();
        for peer in &records {
            let addrs = self.candidates(peer, &discovered);
            if addrs.is_empty() || (!force && !self.due(&peer.device_id)) {
                continue;
            }
            match self.sync_with(peer, &addrs, poke).await {
                Ok(outcome) => {
                    self.record_health(&peer.device_id, true);
                    report.peers_synced += 1;
                    report.rows_received += outcome.rows;
                    report.blobs_fetched += outcome.blobs;
                    touched.extend(outcome.touched);
                    if let Some(error) = &outcome.blob_error {
                        report.errors.push((peer.device_id.clone(), error.clone()));
                    }
                    let _ = self
                        .ws
                        .apply(Mutation::SyncPeers(PeerWrite::RecordContact {
                            device_id: peer.device_id.clone(),
                            name: Some(outcome.name),
                            address: Some(outcome.address.to_string()),
                            reached: true,
                            synced: true,
                            error: outcome.blob_error,
                        }))
                        .await;
                }
                Err(error) => {
                    self.record_health(&peer.device_id, false);
                    let message = match &error {
                        WorkspaceError::Sync(m) => m.clone(),
                        other => other.to_string(),
                    };
                    tracing::debug!(peer = %peer.device_id, error = %message, "sync: peer failed");
                    report
                        .errors
                        .push((peer.device_id.clone(), message.clone()));
                    let _ = self
                        .ws
                        .apply(Mutation::SyncPeers(PeerWrite::RecordContact {
                            device_id: peer.device_id.clone(),
                            name: None,
                            address: None,
                            reached: false,
                            synced: false,
                            error: Some(message),
                        }))
                        .await;
                }
            }
        }
        report.touched_boards = touched.into_iter().collect();
        if !report.touched_boards.is_empty() {
            self.events.applied(&report.touched_boards);
        }
        self.syncing.store(false, Ordering::SeqCst);
        self.emit_state().await;
        report
    }

    async fn sync_with(
        &self,
        peer: &PeerRecord,
        addrs: &[SocketAddr],
        poke: bool,
    ) -> Result<PeerSync, WorkspaceError> {
        // First address that answers /v1/info as the right device.
        let mut last_error = sync_err("unreachable");
        let mut chosen = None;
        for addr in addrs {
            let client = PeerClient::pinned(&self.identity, &peer.cert_fingerprint, *addr)?;
            match client.info().await {
                Ok(info) if info.device_id == peer.device_id => {
                    chosen = Some((client, *addr, info));
                    break;
                }
                Ok(_) => last_error = sync_err("a different device answered"),
                Err(e) => last_error = e,
            }
        }
        let Some((client, address, info)) = chosen else {
            return Err(last_error);
        };
        if poke {
            let _ = client.poke().await;
        }

        let mut outcome = PeerSync {
            name: crate::domain::device::normalize_device_name(&info.name)
                .unwrap_or_else(|_| peer.name.clone()),
            address,
            rows: 0,
            blobs: 0,
            touched: Vec::new(),
            blob_error: None,
        };
        let mut cursors = self.ws.read(journal::our_cursors).await?;
        loop {
            let page = client.changes(&cursors, PAGE).await?;
            if !page.rows.is_empty() {
                outcome.rows += page.rows.len();
                let applied = self
                    .ws
                    .apply(Mutation::ApplySyncChanges(page.rows))
                    .await?
                    .into_sync_report()?;
                outcome.touched.extend(applied.touched_boards);
            }
            match page.next {
                Some(next) => cursors = next,
                None => break,
            }
        }

        let (fetched, blob_error) = self.fetch_missing_blobs(&client).await;
        outcome.blobs = fetched.len();
        outcome.blob_error = blob_error;
        if !fetched.is_empty() {
            if let Ok(boards) = self
                .ws
                .read(move |c| peers::boards_showing_hashes(c, &fetched))
                .await
            {
                outcome.touched.extend(boards);
            }
        }
        Ok(outcome)
    }

    /// Fetches every missing blob this peer holds. Returns the hashes placed
    /// and the first error (a blob the peer lacks is not an error).
    async fn fetch_missing_blobs(&self, client: &PeerClient) -> (Vec<String>, Option<String>) {
        let assets_dir = self.ws.paths().assets_dir();
        let dir = assets_dir.clone();
        let missing = match self.ws.read(move |c| journal::missing_blobs(c, &dir)).await {
            Ok(missing) => missing,
            Err(e) => return (Vec::new(), Some(e.to_string())),
        };
        if missing.is_empty() {
            return (Vec::new(), None);
        }
        if let Err(e) = tokio::fs::create_dir_all(&assets_dir).await {
            return (Vec::new(), Some(format!("cannot create asset dir: {e}")));
        }
        let mut placed = Vec::new();
        let mut first_error = None;
        for sha in missing {
            if !server::is_sha256(&sha) {
                continue;
            }
            let temp = assets_dir.join(format!("sync-{sha}.part"));
            match client.fetch_blob(&sha, &temp).await {
                Ok(true) => {}
                Ok(false) => continue,
                Err(e) => {
                    first_error.get_or_insert_with(|| match e {
                        WorkspaceError::Sync(m) => m,
                        other => other.to_string(),
                    });
                    continue;
                }
            }
            let hash = sha.clone();
            let files = self
                .ws
                .read(move |c| peers::asset_files_for_hash(c, &hash))
                .await
                .unwrap_or_default();
            let dir = assets_dir.clone();
            let temp_file = temp.clone();
            let result = tokio::task::spawn_blocking(move || place_blob(&dir, &temp_file, &files))
                .await
                .unwrap_or_else(|e| Err(e.to_string()));
            let _ = tokio::fs::remove_file(&temp).await;
            match result {
                Ok(()) => placed.push(sha),
                Err(e) => {
                    first_error.get_or_insert(e);
                }
            }
        }
        (placed, first_error)
    }
}

/// Copies a verified blob to every missing asset file name (atomic per file:
/// copy to a temp name, then rename).
fn place_blob(
    assets_dir: &std::path::Path,
    temp: &std::path::Path,
    files: &[String],
) -> Result<(), String> {
    for name in files {
        if !crate::is_safe_asset_name(name) {
            continue;
        }
        let dest = assets_dir.join(name);
        if dest.is_file() {
            continue;
        }
        let staging = assets_dir.join(format!("{name}.sync-part"));
        std::fs::copy(temp, &staging).map_err(|e| format!("cannot place blob: {e}"))?;
        std::fs::rename(&staging, &dest).map_err(|e| {
            let _ = std::fs::remove_file(&staging);
            format!("cannot place blob: {e}")
        })?;
    }
    Ok(())
}

/// What syncing with one peer did.
#[derive(Debug)]
struct PeerSync {
    name: String,
    address: SocketAddr,
    rows: usize,
    blobs: usize,
    touched: Vec<String>,
    blob_error: Option<String>,
}

/// `host:port` → socket addresses (a bare IP without port is refused: the
/// port is random per device and shown in its Devices dialog).
async fn resolve(address: &str) -> Result<Vec<SocketAddr>, WorkspaceError> {
    let address = address.trim();
    if let Ok(addr) = address.parse::<SocketAddr>() {
        return Ok(vec![addr]);
    }
    if !address.contains(':') {
        return Err(WorkspaceError::ConstraintViolation(
            "enter the address as host:port (shown in the other device's Devices dialog)".into(),
        ));
    }
    let addrs: Vec<SocketAddr> = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host(address.to_string()),
    )
    .await
    .map_err(|_| sync_err(format!("cannot resolve {address}")))?
    .map_err(|e| sync_err(format!("cannot resolve {address}: {e}")))?
    .collect();
    Ok(addrs)
}
