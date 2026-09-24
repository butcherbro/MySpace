//! Device identity (ADR-0012 §1).
//!
//! Every installation has a stable `device_id` (UUIDv7) and a human
//! `device_name` that defaults to the machine's host name and can be renamed.
//! Both live in `local_meta` (never synced); the name is also mirrored into
//! `known_devices`, which is what labels a shortcut created elsewhere
//! ("On <name>"). Storage is in `repositories::devices`.

use serde::{Deserialize, Serialize};

use crate::domain::errors::WorkspaceError;

/// Name used when the host name is unavailable or blank.
pub const FALLBACK_DEVICE_NAME: &str = "This computer";

/// Longest accepted device name, in characters.
pub const MAX_DEVICE_NAME_CHARS: usize = 64;

/// `local_meta` key holding this installation's device id.
pub const DEVICE_ID_KEY: &str = "device_id";

/// `local_meta` key holding this installation's device name.
pub const DEVICE_NAME_KEY: &str = "device_name";

/// `local_meta` key holding the [`machine_fingerprint`] the identity belongs
/// to. A database opened under a different fingerprint (copied to another
/// machine, restored for another user) gets a new identity.
pub const MACHINE_FINGERPRINT_KEY: &str = "machine_fingerprint";

/// This installation's identity, as returned by `get_device_identity`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub device_id: String,
    pub device_name: String,
}

/// The default device name: the host name without a mDNS/DNS suffix
/// (`Johns-MacBook-Pro.local` -> `Johns-MacBook-Pro`), or
/// [`FALLBACK_DEVICE_NAME`].
pub fn default_device_name() -> String {
    device_name_from_host(&gethostname::gethostname().to_string_lossy())
}

/// The host name without its domain suffix, as used by the fingerprint.
fn short_host(host: &str) -> &str {
    host.trim().split('.').next().unwrap_or("").trim()
}

/// Hex SHA-256 over `machine_key` (see [`current_machine_fingerprint`]), the
/// OS (`std::env::consts::OS`) and the data directory exactly as given to
/// `WorkspacePaths`. Stable for one install; differs across machines and user
/// accounts; moving the data directory changes it.
pub fn machine_fingerprint(machine_key: &str, os: &str, data_dir: &std::path::Path) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for part in [
        machine_key.as_bytes(),
        os.as_bytes(),
        data_dir.as_os_str().to_string_lossy().as_bytes(),
    ] {
        // Length-prefixed so ("ab", "c") and ("a", "bc") never collide.
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part);
    }
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The machine part of the fingerprint: the OS machine id (`machine-uid`:
/// `IOPlatformUUID` on macOS, `HKLM\...\Cryptography\MachineGuid` on
/// Windows, `/etc/machine-id` on Linux), which survives host renames and
/// DHCP-assigned host names. Only if it cannot be read, the short host name,
/// with a warning (`machine_id_unavailable`). The two sources are tagged so
/// they can never produce the same key.
pub fn machine_key(machine_id: Result<String, String>, host: impl FnOnce() -> String) -> String {
    match machine_id {
        Ok(id) if !id.trim().is_empty() => format!("machine-id:{}", id.trim()),
        result => {
            let reason = match result {
                Err(error) => error,
                Ok(_) => "empty machine id".to_string(),
            };
            tracing::warn!(
                error_code = "machine_id_unavailable",
                reason = %reason,
                "OS machine id unavailable; device fingerprint falls back to the host name"
            );
            format!("host:{}", short_host(&host()))
        }
    }
}

/// [`machine_fingerprint`] of this process for `data_dir`.
pub fn current_machine_fingerprint(data_dir: &std::path::Path) -> String {
    let key = machine_key(machine_uid::get().map_err(|e| e.to_string()), || {
        gethostname::gethostname().to_string_lossy().into_owned()
    });
    machine_fingerprint(&key, std::env::consts::OS, data_dir)
}

/// [`default_device_name`] for a given raw host name (testable).
pub fn device_name_from_host(host: &str) -> String {
    match normalize_device_name(short_host(host)) {
        Ok(name) => name,
        Err(_) => FALLBACK_DEVICE_NAME.to_string(),
    }
}

/// Validates a user-supplied device name: trimmed, non-empty, no control
/// characters, at most [`MAX_DEVICE_NAME_CHARS`] characters.
pub fn normalize_device_name(raw: &str) -> Result<String, WorkspaceError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(WorkspaceError::ConstraintViolation(
            "device name must not be empty".into(),
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(WorkspaceError::ConstraintViolation(
            "device name must not contain control characters".into(),
        ));
    }
    if name.chars().count() > MAX_DEVICE_NAME_CHARS {
        return Err(WorkspaceError::ConstraintViolation(format!(
            "device name must be at most {MAX_DEVICE_NAME_CHARS} characters"
        )));
    }
    Ok(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_names_lose_their_domain_suffix() {
        assert_eq!(
            device_name_from_host("Johns-MacBook-Pro.local"),
            "Johns-MacBook-Pro"
        );
        assert_eq!(device_name_from_host("DESKTOP-4F2K"), "DESKTOP-4F2K");
        assert_eq!(device_name_from_host("  "), FALLBACK_DEVICE_NAME);
        assert_eq!(device_name_from_host(".local"), FALLBACK_DEVICE_NAME);
    }

    #[test]
    fn device_names_are_validated() {
        assert_eq!(
            normalize_device_name("  Studio Mac ").unwrap(),
            "Studio Mac"
        );
        assert!(normalize_device_name("").is_err());
        assert!(normalize_device_name("a\u{7}b").is_err());
        assert!(normalize_device_name(&"x".repeat(65)).is_err());
        assert!(normalize_device_name(&"é".repeat(64)).is_ok());
    }

    #[test]
    fn the_fingerprint_covers_machine_os_and_data_dir() {
        use std::path::Path;
        let dir = Path::new("/Users/me/MySpace");
        let base = machine_fingerprint("machine-id:A1", "macos", dir);
        assert_eq!(base.len(), 64);
        assert_eq!(base, machine_fingerprint("machine-id:A1", "macos", dir));
        assert_ne!(base, machine_fingerprint("machine-id:B2", "macos", dir));
        assert_ne!(base, machine_fingerprint("machine-id:A1", "windows", dir));
        assert_ne!(
            base,
            machine_fingerprint("machine-id:A1", "macos", Path::new("/Users/you/MySpace"))
        );
    }

    #[test]
    fn the_machine_key_prefers_the_os_machine_id_over_the_host_name() {
        // A host rename (or a DHCP-assigned name) does not change the key.
        let from_id = |host: &'static str| machine_key(Ok(" A1-B2 \n".into()), move || host.into());
        assert_eq!(from_id("mac.local"), "machine-id:A1-B2");
        assert_eq!(from_id("dhcp-10-0-0-7.lan"), "machine-id:A1-B2");
        // Fallback: the short host name, tagged apart from machine ids.
        assert_eq!(
            machine_key(Err("no /etc/machine-id".into()), || "mac.local".into()),
            "host:mac"
        );
        assert_eq!(machine_key(Ok("  ".into()), || "pc".into()), "host:pc");
    }

    #[test]
    fn this_machine_has_a_fingerprint() {
        assert_eq!(
            current_machine_fingerprint(std::path::Path::new("/tmp/x")).len(),
            64
        );
    }

    #[test]
    fn the_default_name_is_never_empty() {
        assert!(!default_device_name().is_empty());
    }
}
