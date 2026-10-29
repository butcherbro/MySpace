//! Pairing (ADR-0011 S3, pairing protocol 2): an 8-digit code shown on one
//! device and typed on the other authenticates the exchange of certificate
//! fingerprints through SPAKE2 (`spake2.rs`).
//!
//! ```text
//! A: "Pair a device" → code C (8 digits, 5 min, 5 attempts)
//! B → A  GET  /pair        → {deviceId_A, name_A, fp_A, pairing: 2}
//!        (TLS: B presents cert_B; B accepts cert_A unpinned and records fp_A)
//! B → A  POST /pair/begin  {msg_B}        SPAKE2 Bob(fp_B, fp_A, C)
//! A → B  {msg_A, session}                 SPAKE2 Alice(fp_A, fp_B, C) → K
//! B → A  POST /pair  {session, deviceId_B, name_B, fp_B, proof_B = HMAC(K, fp_B ‖ fp_A)}
//! A: fp_B == hash(presented client cert)?  proof_B valid?  → store B, burn C
//! A → B  {deviceId_A, name_A, fp_A, proof_A = HMAC(K, fp_A ‖ fp_B)}
//! B: fp_A == hash(presented server cert)?  proof_A valid?  → store A
//! ```
//!
//! K depends on the code and on both fingerprints as seen on the TLS channel,
//! so a relay in the middle (whose certificates differ) derives nothing
//! useful, and an active attacker gets one guess of the code per session.
//! Each session uses up one of the code's [`MAX_ATTEMPTS`] when it begins.
//!
//! The code has 8 digits so that a build from before protocol 2, which
//! accepts exactly 6, refuses it before sending a code-keyed HMAC that a
//! man-in-the-middle could brute-force offline.

use std::time::{Duration, Instant};

use zeroize::Zeroize;

use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use super::spake2::{Role, SharedKey, Spake2};

/// How long a pairing code is valid.
pub const CODE_TTL: Duration = Duration::from_secs(5 * 60);
/// SPAKE2 sessions (each one guess) allowed per code before it is burnt.
pub const MAX_ATTEMPTS: u32 = 5;
/// How long a begun session waits for its confirmation.
pub const SESSION_TTL: Duration = Duration::from_secs(60);

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

/// `HMAC-SHA256(key, own_fp ‖ other_fp)`, lowercase hex.
pub fn proof(key: &[u8], own_fp: &str, other_fp: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(own_fp.as_bytes());
    mac.update(other_fp.as_bytes());
    hex_lower(&mac.finalize().into_bytes())
}

/// Constant-time check of a hex proof.
pub fn verify_proof(key: &[u8], own_fp: &str, other_fp: &str, proof_hex: &str) -> bool {
    let Some(bytes) = decode_hex(proof_hex) else {
        return false;
    };
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(own_fp.as_bytes());
    mac.update(other_fp.as_bytes());
    mac.verify_slice(&bytes).is_ok()
}

/// Lowercase hex without a prefix, two digits per byte. Written by hand because
/// digest 0.11 outputs (`hybrid-array`) no longer implement `LowerHex`; the
/// strings are stored sha256 ids and TLS fingerprints, so the format is frozen.
pub fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, b| {
            write!(out, "{b:02x}").expect("writing to a String cannot fail");
            out
        })
}

/// Inverse of [`hex_lower`] (either case); `None` for anything else.
pub fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || !s.is_ascii() {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    super::tls::provider()
        .secure_random
        .fill(&mut bytes)
        .expect("the system CSPRNG is available");
    bytes
}

/// Digits in a pairing code.
pub const CODE_DIGITS: usize = 8;
/// Digits in the codes of builds before pairing protocol 2.
pub const OLD_CODE_DIGITS: usize = 6;

/// A fresh uniformly random 8-digit code (the TLS provider's CSPRNG).
pub fn new_code() -> String {
    let bytes = random_bytes::<16>();
    // 128 random bits reduced mod 10^8: the bias is below 2^-100.
    let n = u128::from_le_bytes(bytes) % 100_000_000;
    format!("{n:08}")
}

/// What the user typed without spaces and dashes, if it is `len` digits.
fn digits_of(raw: &str, len: usize) -> Option<String> {
    let digits: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    (digits.len() == len && digits.chars().all(|c| c.is_ascii_digit())).then_some(digits)
}

/// Normalizes what the user typed ("1234 5678" → "12345678").
pub fn normalize_code(raw: &str) -> Option<String> {
    digits_of(raw, CODE_DIGITS)
}

/// The user typed a code in the format of a build before protocol 2.
pub fn is_old_code(raw: &str) -> bool {
    digits_of(raw, OLD_CODE_DIGITS).is_some()
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

/// Why a `/pair/begin` or `/pair` request was refused (mapped to HTTP
/// statuses).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairRefusal {
    /// No code shown, or it expired: 410.
    NoActiveCode,
    /// Wrong proof: 403.
    WrongCode,
    /// All attempts of the code are used up (429); after a wrong proof the
    /// code is burnt.
    TooManyAttempts,
    /// The SPAKE2 message could not be used: 400.
    InvalidMessage,
    /// SPAKE2 failed on this side (no attempt used): 500.
    Internal,
    /// No such session for this client (expired, already confirmed, or the
    /// code was replaced): 409.
    UnknownSession,
}

/// A begun SPAKE2 session waiting for B's confirmation.
struct Session {
    id: String,
    peer_fp: String,
    key: SharedKey,
    created: Instant,
}

/// Pairing window state of one device.
#[derive(Default)]
pub struct PairingWindow {
    active: Option<ActiveCode>,
    /// Sessions of the active code (at most [`MAX_ATTEMPTS`]).
    sessions: Vec<Session>,
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
        self.burn();
        self.active = Some(code.clone());
        code
    }

    pub fn cancel(&mut self) {
        self.burn();
    }

    fn burn(&mut self) {
        // Код больше не нужен: затираем, а не просто отпускаем строку в аллокатор.
        if let Some(mut active) = self.active.take() {
            active.code.zeroize();
        }
        self.sessions.clear();
    }

    pub fn active(&mut self) -> Option<&ActiveCode> {
        if self
            .active
            .as_ref()
            .is_some_and(|c| c.created.elapsed() > CODE_TTL)
        {
            self.burn();
        }
        self.active.as_ref()
    }

    /// `POST /pair/begin`: runs SPAKE2 as Alice against the peer's message.
    /// Uses up one attempt of the code whatever happens next, so a session
    /// never confirmed still counts as the guess it could have been.
    /// Returns the session id and our message.
    pub fn begin_session(
        &mut self,
        peer_fp: &str,
        own_fp: &str,
        peer_msg: &[u8],
    ) -> Result<(String, Vec<u8>), PairRefusal> {
        if self.active().is_none() {
            return Err(PairRefusal::NoActiveCode);
        }
        let active = self.active.as_mut().expect("checked above");
        if active.attempts >= MAX_ATTEMPTS {
            // Все попытки розданы: код больше не может сработать честно,
            // A не должен показывать мёртвый код дальше.
            self.burn();
            return Err(PairRefusal::TooManyAttempts);
        }
        // Сбой start — наша ошибка, попытку не тратит; сообщение пира
        // проверяется только после списания попытки.
        let (run, msg) = Spake2::start(Role::Alice, own_fp, peer_fp, &active.code)
            .map_err(|_| PairRefusal::Internal)?;
        active.attempts += 1;
        let key = run
            .finish(peer_msg)
            .map_err(|_| PairRefusal::InvalidMessage)?;
        let id = hex_lower(&random_bytes::<16>());
        self.sessions.push(Session {
            id: id.clone(),
            peer_fp: peer_fp.to_string(),
            key,
            created: Instant::now(),
        });
        Ok((id, msg))
    }

    /// `POST /pair`: checks a peer's proof against the key of its session.
    /// The session is consumed; the code is burnt on success and after a
    /// wrong proof once all attempts are used. Returns the key on success
    /// (the caller computes its own proof).
    pub fn attempt(
        &mut self,
        session_id: &str,
        peer_fp: &str,
        own_fp: &str,
        peer_proof: &str,
    ) -> Result<SharedKey, PairRefusal> {
        self.attempt_at(session_id, peer_fp, own_fp, peer_proof, Instant::now())
    }

    fn attempt_at(
        &mut self,
        session_id: &str,
        peer_fp: &str,
        own_fp: &str,
        peer_proof: &str,
        now: Instant,
    ) -> Result<SharedKey, PairRefusal> {
        if self.active().is_none() {
            return Err(PairRefusal::NoActiveCode);
        }
        self.sessions
            .retain(|s| now.saturating_duration_since(s.created) <= SESSION_TTL);
        let index = self
            .sessions
            .iter()
            .position(|s| s.id == session_id && s.peer_fp == peer_fp)
            .ok_or(PairRefusal::UnknownSession)?;
        let session = self.sessions.swap_remove(index);
        if verify_proof(&session.key[..], peer_fp, own_fp, peer_proof) {
            self.burn();
            return Ok(session.key);
        }
        let attempts = self.active.as_ref().expect("checked above").attempts;
        if attempts >= MAX_ATTEMPTS {
            self.burn();
            return Err(PairRefusal::TooManyAttempts);
        }
        Err(PairRefusal::WrongCode)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proofs_bind_both_fingerprints_in_order() {
        let key = [7u8; 64];
        let p = proof(&key, "aa", "bb");
        assert!(verify_proof(&key, "aa", "bb", &p));
        assert!(!verify_proof(&key, "bb", "aa", &p));
        assert!(!verify_proof(&[8u8; 64], "aa", "bb", &p));
        assert!(!verify_proof(&key, "aa", "bb", "zz"));
        assert_eq!(p.len(), 64);
    }

    #[test]
    fn hex_lower_matches_known_vectors() {
        use sha2::Digest;
        // Формат зафиксирован: так хранятся sha256 ассетов и отпечатки пиров.
        assert_eq!(
            hex_lower(&Sha256::digest(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(hex_lower(&[0x00, 0x0f]), "000f");
        assert_eq!(hex_lower(&[]), "");
    }

    #[test]
    fn codes_are_eight_digits() {
        for _ in 0..50 {
            let c = new_code();
            assert_eq!(c.len(), 8);
            assert_eq!(normalize_code(&c).as_deref(), Some(c.as_str()));
        }
        assert_eq!(normalize_code(" 1234 5678 ").as_deref(), Some("12345678"));
        assert_eq!(normalize_code("1234-5678").as_deref(), Some("12345678"));
        assert_eq!(normalize_code("123456"), None);
        assert_eq!(normalize_code("1234567a"), None);
        assert!(is_old_code("123 456"));
        assert!(!is_old_code("12345678"));
    }

    /// Bob's half of a session against `w` with `code`: (session, key).
    fn bob(w: &mut PairingWindow, code: &str) -> Result<(String, SharedKey), PairRefusal> {
        let (run, msg_b) = Spake2::start(Role::Bob, "b", "a", code).unwrap();
        let (id, msg_a) = w.begin_session("b", "a", &msg_b)?;
        Ok((id, run.finish(&msg_a).unwrap()))
    }

    #[test]
    fn a_session_is_one_guess_and_the_code_is_burnt_after_five() {
        let mut w = PairingWindow::default();
        assert!(matches!(
            w.begin_session("b", "a", &[0; 32]),
            Err(PairRefusal::NoActiveCode)
        ));
        let code = w.begin(0).code;
        let (id, key) = bob(&mut w, &code).unwrap();
        // Another client cannot confirm B's session.
        let good = proof(&key[..], "b", "a");
        assert_eq!(
            w.attempt(&id, "c", "a", &good),
            Err(PairRefusal::UnknownSession)
        );
        assert_eq!(w.attempt(&id, "b", "a", &good), Ok(key));
        assert_eq!(
            w.attempt(&id, "b", "a", &good),
            Err(PairRefusal::NoActiveCode)
        );

        let code = w.begin(0).code;
        let wrong = if code == "00000000" {
            "00000001"
        } else {
            "00000000"
        };
        for _ in 1..MAX_ATTEMPTS {
            let (id, key) = bob(&mut w, wrong).unwrap();
            assert_eq!(
                w.attempt(&id, "b", "a", &proof(&key[..], "b", "a")),
                Err(PairRefusal::WrongCode)
            );
            // A session is confirmed at most once.
            assert_eq!(
                w.attempt(&id, "b", "a", &proof(&key[..], "b", "a")),
                Err(PairRefusal::UnknownSession)
            );
        }
        let (id, key) = bob(&mut w, wrong).unwrap();
        assert_eq!(
            w.attempt(&id, "b", "a", &proof(&key[..], "b", "a")),
            Err(PairRefusal::TooManyAttempts)
        );
        // Burnt: even the right code is refused now.
        assert!(matches!(bob(&mut w, &code), Err(PairRefusal::NoActiveCode)));
    }

    #[test]
    fn a_begin_past_the_limit_burns_the_code() {
        let mut w = PairingWindow::default();
        let code = w.begin(0).code;
        let mut pending = Vec::new();
        for _ in 0..MAX_ATTEMPTS {
            pending.push(bob(&mut w, &code).unwrap());
        }
        assert!(matches!(
            bob(&mut w, &code),
            Err(PairRefusal::TooManyAttempts)
        ));
        assert!(w.active().is_none());
        // Начатые сессии сгорели вместе с кодом.
        let (id, key) = pending.pop().unwrap();
        assert_eq!(
            w.attempt(&id, "b", "a", &proof(&key[..], "b", "a")),
            Err(PairRefusal::NoActiveCode)
        );
    }

    #[test]
    fn a_new_code_drops_the_sessions_of_the_old_one() {
        let mut w = PairingWindow::default();
        let code = w.begin(0).code;
        let (id, key) = bob(&mut w, &code).unwrap();
        w.begin(0);
        assert_eq!(
            w.attempt(&id, "b", "a", &proof(&key[..], "b", "a")),
            Err(PairRefusal::UnknownSession)
        );
        assert!(matches!(
            w.begin_session("b", "a", &[1, 2, 3]),
            Err(PairRefusal::InvalidMessage)
        ));
    }

    #[test]
    fn a_session_expires_after_its_ttl() {
        let mut w = PairingWindow::default();
        let code = w.begin(0).code;
        let (id, key) = bob(&mut w, &code).unwrap();
        let late = Instant::now() + SESSION_TTL + Duration::from_secs(1);
        assert_eq!(
            w.attempt_at(&id, "b", "a", &proof(&key[..], "b", "a"), late),
            Err(PairRefusal::UnknownSession)
        );
        // Только сессия истекла; код жив, новая сессия проходит.
        let (id, key) = bob(&mut w, &code).unwrap();
        assert_eq!(
            w.attempt(&id, "b", "a", &proof(&key[..], "b", "a")),
            Ok(key)
        );
    }
}
