//! mDNS discovery for the LAN transport (ADR-0011 S3): advertises
//! `_myspace-sync._tcp.local.` with TXT `device_id`, `name`, `fp` and the
//! server port, and browses for other devices continuously.
//!
//! Discovery is a convenience: a failure (no multicast, a firewall) is
//! logged and reported as "discovery unavailable"; pairing by address and
//! syncing with a peer's last known address keep working.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;

use crate::db::migrations::now_millis;

pub const SERVICE_TYPE: &str = "_myspace-sync._tcp.local.";

/// A device seen on the network.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovered {
    pub device_id: String,
    pub name: String,
    pub addrs: Vec<IpAddr>,
    pub port: u16,
    pub fingerprint: String,
    /// Unix ms of the last resolution.
    pub seen_at: i64,
}

impl Discovered {
    /// Candidate socket addresses, IPv4 first (link-local IPv6 needs a scope
    /// id the advert does not carry).
    pub fn socket_addrs(&self) -> Vec<SocketAddr> {
        let mut addrs: Vec<SocketAddr> = self
            .addrs
            .iter()
            .filter(|ip| match ip {
                IpAddr::V4(v4) => !v4.is_loopback() && !v4.is_unspecified(),
                IpAddr::V6(v6) => !v6.is_loopback() && (v6.segments()[0] & 0xffc0) != 0xfe80,
            })
            .map(|ip| SocketAddr::new(*ip, self.port))
            .collect();
        addrs.sort_by_key(|a| !a.is_ipv4());
        addrs
    }
}

/// Shared map of what discovery currently sees, by device id.
pub type DiscoveredMap = Arc<Mutex<HashMap<String, Discovered>>>;

/// The running advert + browser.
pub struct Discovery {
    daemon: ServiceDaemon,
}

impl Discovery {
    /// Starts advertising this device and browsing for others. `on_change`
    /// runs (on a discovery thread) whenever the map changes.
    pub fn start(
        device_id: &str,
        name: &str,
        fingerprint: &str,
        port: u16,
        map: DiscoveredMap,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Self, String> {
        let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
        let host = format!("{device_id}.local.");
        let properties = [
            ("device_id", device_id),
            ("name", name),
            ("fp", fingerprint),
        ];
        let info = ServiceInfo::new(SERVICE_TYPE, device_id, &host, "", port, &properties[..])
            .map_err(|e| e.to_string())?
            .enable_addr_auto();
        daemon.register(info).map_err(|e| e.to_string())?;
        let events = daemon.browse(SERVICE_TYPE).map_err(|e| e.to_string())?;
        let own = device_id.to_string();
        std::thread::Builder::new()
            .name("myspace-mdns".into())
            .spawn(move || {
                // fullname → device id, to handle removals.
                let mut names: HashMap<String, String> = HashMap::new();
                while let Ok(event) = events.recv() {
                    let changed = match event {
                        ServiceEvent::ServiceResolved(service) => {
                            let prop =
                                |k: &str| service.get_property_val_str(k).unwrap_or("").to_string();
                            let id = prop("device_id");
                            let fp = prop("fp").to_ascii_lowercase();
                            if id.is_empty() || id == own || fp.len() != 64 {
                                false
                            } else {
                                names.insert(service.get_fullname().to_string(), id.clone());
                                let mut addrs: Vec<IpAddr> = service
                                    .get_addresses()
                                    .iter()
                                    .map(|a| a.to_ip_addr())
                                    .collect();
                                addrs.sort();
                                let entry = Discovered {
                                    device_id: id.clone(),
                                    name: prop("name"),
                                    addrs,
                                    port: service.get_port(),
                                    fingerprint: fp,
                                    seen_at: now_millis(),
                                };
                                match map.lock() {
                                    // Nothing reachable yet (only loopback or
                                    // link-local): wait for a later resolution.
                                    Ok(_) if entry.socket_addrs().is_empty() => false,
                                    Ok(mut m) => {
                                        let changed = m.get(&id).is_none_or(|old| {
                                            old.addrs != entry.addrs
                                                || old.port != entry.port
                                                || old.name != entry.name
                                                || old.fingerprint != entry.fingerprint
                                        });
                                        m.insert(id, entry);
                                        changed
                                    }
                                    Err(_) => false,
                                }
                            }
                        }
                        ServiceEvent::ServiceRemoved(_, fullname) => {
                            match (names.remove(&fullname), map.lock()) {
                                (Some(id), Ok(mut m)) => m.remove(&id).is_some(),
                                _ => false,
                            }
                        }
                        _ => false,
                    };
                    if changed {
                        on_change();
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self { daemon })
    }

    pub fn stop(&self) {
        let _ = self.daemon.shutdown();
    }
}
