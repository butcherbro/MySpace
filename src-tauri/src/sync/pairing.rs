//! Pairing (ADR-0011 S3): a 6-digit code shown on one device and typed on
//! the other authenticates the exchange of certificate fingerprints.
//!
//! ```text
//! A: "Pair a device" → code C (5 min, 5 attempts)
//! B → A  POST /pair  {deviceId_B, name_B, fp_B, proof_B = HMAC(C, fp_B ‖ fp_A)}
//!        (TLS: B presents cert_B; B accepts cert_A unpinned and records fp_A)
//! A: fp_B == hash(presented client cert)?  proof_B valid?  → store B, burn C
//! A → B  {deviceId_A, name_A, fp_A, proof_A = HMAC(C, fp_A ‖ fp_B)}
//! B: fp_A == hash(presented server cert)?  proof_A valid?  → store A
//! ```
//!
//! Each proof binds both fingerprints as seen on the TLS channel, so a relay
//! in the middle (whose certificates differ) cannot reuse them. The code has
//! only 10^6 values: see the threat model in the README ("Sync (LAN)").

use std::time::{Duration, Instant};

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// How long a pairing code is valid.
pub const CODE_TTL: Duration = Duration::from_secs(5 * 60);
/// Wrong answers accepted per code before it is burnt.
pub const MAX_ATTEMPTS: u32 = 5;

type HmacSha256 = Hmac<Sha256>;

/// `/pair` request and response body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairMessage {
    pub device_id: String,
    pub name: String,
    pub fingerprint: String,
    /// Lowercase hex HMAC-SHA256.
    pub proof: String,
}

/// `HMAC-SHA256(code, own_fp ‖ other_fp)`, lowercase hex.
pub fn proof(code: &str, own_fp: &str, other_fp: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(code.as_bytes()).expect("HMAC takes any key length");
    mac.update(own_fp.as_bytes());
    mac.update(other_fp.as_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Constant-time check of a hex proof.
pub fn verify_proof(code: &str, own_fp: &str, other_fp: &str, proof_hex: &str) -> bool {
    let Some(bytes) = decode_hex(proof_hex) else {
        return false;
    };
    let mut mac = HmacSha256::new_from_slice(code.as_bytes()).expect("HMAC takes any key length");
    mac.update(own_fp.as_bytes());
    mac.update(other_fp.as_bytes());
    mac.verify_slice(&bytes).is_ok()
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || !s.is_ascii() {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// A fresh uniformly random 6-digit code (the TLS provider's CSPRNG).
pub fn new_code() -> String {
    let mut bytes = [0u8; 16];
    super::tls::provider()
        .secure_random
        .fill(&mut bytes)
        .expect("the system CSPRNG is available");
    // 128 random bits reduced mod 10^6: the bias is below 2^-100.
    let n = u128::from_le_bytes(bytes) % 1_000_000;
    format!("{n:06}")
}

/// Normalizes what the user typed ("123 456" → "123456").
pub fn normalize_code(raw: &str) -> Option<String> {
    let digits: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    (digits.len() == 6 && digits.chars().all(|c| c.is_ascii_digit())).then_some(digits)
}

/// The code this device is currently showing.
#[derive(Debug, Clone)]
pub struct ActiveCode {
    pub code: String,
    pub created: Instant,
    /// Unix ms, for the UI.
    pub expires_at_ms: i64,
    pub attempts: u32,
}

/// Why a `/pair` request was refused (mapped to HTTP statuses).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairRefusal {
    /// No code shown, or it expired: 410.
    NoActiveCode,
    /// Wrong proof: 403.
    WrongCode,
    /// Wrong proof, and it was the last allowed attempt: the code is burnt
    /// (429).
    TooManyAttempts,
}

/// Pairing window state of one device.
#[derive(Debug, Default)]
pub struct PairingWindow {
    active: Option<ActiveCode>,
}

impl PairingWindow {
    /// Shows a new code (replacing any previous one).
    pub fn begin(&mut self, now_ms: i64) -> ActiveCode {
        let code = ActiveCode {
            code: new_code(),
            created: Instant::now(),
            expires_at_ms: now_ms + CODE_TTL.as_millis() as i64,
            attempts: 0,
        };
        self.active = Some(code.clone());
        code
    }

    pub fn cancel(&mut self) {
        self.active = None;
    }

    pub fn active(&mut self) -> Option<&ActiveCode> {
        if self
            .active
            .as_ref()
            .is_some_and(|c| c.created.elapsed() > CODE_TTL)
        {
            self.active = None;
        }
        self.active.as_ref()
    }

    /// Checks a peer's proof against the active code. Counts the attempt;
    /// the code is burnt on success and after [`MAX_ATTEMPTS`] failures.
    /// Returns the code on success (the caller computes its own proof).
    pub fn attempt(
        &mut self,
        peer_fp: &str,
        own_fp: &str,
        peer_proof: &str,
    ) -> Result<String, PairRefusal> {
        if self.active().is_none() {
            return Err(PairRefusal::NoActiveCode);
        }
        let active = self.active.as_mut().expect("checked above");
        active.attempts += 1;
        if verify_proof(&active.code, peer_fp, own_fp, peer_proof) {
            let code = active.code.clone();
            self.active = None;
            Ok(code)
        } else {
            if active.attempts >= MAX_ATTEMPTS {
                self.active = None;
                return Err(PairRefusal::TooManyAttempts);
            }
            Err(PairRefusal::WrongCode)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proofs_bind_both_fingerprints_in_order() {
        let p = proof("123456", "aa", "bb");
        assert!(verify_proof("123456", "aa", "bb", &p));
        assert!(!verify_proof("123456", "bb", "aa", &p));
        assert!(!verify_proof("123457", "aa", "bb", &p));
        assert!(!verify_proof("123456", "aa", "bb", "zz"));
        assert_eq!(p.len(), 64);
    }

    #[test]
    fn codes_are_six_digits() {
        for _ in 0..50 {
            let c = new_code();
            assert_eq!(normalize_code(&c).as_deref(), Some(c.as_str()));
        }
        assert_eq!(normalize_code(" 123 456 ").as_deref(), Some("123456"));
        assert_eq!(normalize_code("12345"), None);
        assert_eq!(normalize_code("12345a"), None);
    }

    #[test]
    fn a_code_is_burnt_after_success_or_five_failures() {
        let mut w = PairingWindow::default();
        assert_eq!(w.attempt("b", "a", "00"), Err(PairRefusal::NoActiveCode));
        let code = w.begin(0).code;
        let good = proof(&code, "b", "a");
        assert_eq!(w.attempt("b", "a", &good), Ok(code));
        assert_eq!(w.attempt("b", "a", &good), Err(PairRefusal::NoActiveCode));

        let code = w.begin(0).code;
        for _ in 1..MAX_ATTEMPTS {
            assert_eq!(w.attempt("b", "a", "00"), Err(PairRefusal::WrongCode));
        }
        assert_eq!(w.attempt("b", "a", "00"), Err(PairRefusal::TooManyAttempts));
        // Burnt: even the right proof is refused now.
        let good = proof(&code, "b", "a");
        assert_eq!(w.attempt("b", "a", &good), Err(PairRefusal::NoActiveCode));
    }
}
