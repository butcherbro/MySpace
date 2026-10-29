//! SPAKE2 for pairing (ADR-0011 S3): a safe wrapper over BoringSSL's
//! implementation shipped in `aws-lc-sys`. The device showing the code is
//! Alice, the device typing it is Bob; the names are the two TLS certificate
//! fingerprints, so a relay with its own certificates derives a different key.
//! An active attacker gets one guess of the code per run of the protocol.

use std::ptr::NonNull;

use aws_lc_sys as sys;
use zeroize::Zeroizing;

/// Largest SPAKE2 message, bytes.
const MAX_MSG: usize = sys::SPAKE2_MAX_MSG_SIZE as usize;
/// Length of the shared key, bytes.
pub const KEY_LEN: usize = sys::SPAKE2_MAX_KEY_SIZE as usize;

/// Which side of the exchange this device is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The device showing the code.
    Alice,
    /// The device that typed the code.
    Bob,
}

/// The library refused an input (an invalid peer message).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Spake2Error;

/// Shared key both sides derive when they used the same code and names;
/// wiped from memory when dropped.
pub type SharedKey = Zeroizing<[u8; KEY_LEN]>;

/// One run of the protocol: [`start`](Self::start) sends our message,
/// [`finish`](Self::finish) takes theirs and yields the key.
pub struct Spake2 {
    ctx: NonNull<sys::SPAKE2_CTX>,
}

impl Spake2 {
    /// Starts a run; returns the context and the message to send.
    pub fn start(
        role: Role,
        my_name: &str,
        their_name: &str,
        password: &str,
    ) -> Result<(Self, Vec<u8>), Spake2Error> {
        let role = match role {
            Role::Alice => sys::spake2_role_t_spake2_role_alice,
            Role::Bob => sys::spake2_role_t_spake2_role_bob,
        };
        // SAFETY: указатели и длины взяты из живых &str на время вызова;
        // библиотека копирует имена в контекст и не хранит наши указатели.
        let raw = unsafe {
            sys::SPAKE2_CTX_new(
                role,
                my_name.as_ptr(),
                my_name.len(),
                their_name.as_ptr(),
                their_name.len(),
            )
        };
        let ctx = Self {
            ctx: NonNull::new(raw).ok_or(Spake2Error)?,
        };
        let mut msg = vec![0u8; MAX_MSG];
        let mut len = 0usize;
        // SAFETY: ctx — свежий контекст, generate_msg вызывается на нём ровно
        // один раз (start потребляет только что созданный ctx); out — буфер
        // на MAX_MSG байт, его длина передана как max_out_len.
        let ok = unsafe {
            sys::SPAKE2_generate_msg(
                ctx.ctx.as_ptr(),
                msg.as_mut_ptr(),
                &mut len,
                msg.len(),
                password.as_ptr(),
                password.len(),
            )
        };
        if ok != 1 {
            return Err(Spake2Error);
        }
        msg.truncate(len);
        Ok((ctx, msg))
    }

    /// Completes the run with the peer's message. Consumes the context: the
    /// library allows nothing but freeing it afterwards.
    pub fn finish(self, their_msg: &[u8]) -> Result<SharedKey, Spake2Error> {
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        let mut len = 0usize;
        // SAFETY: generate_msg уже вызван в start (иначе Spake2 не создать),
        // process_msg — второй и последний вызов на этом ctx (self потребляется);
        // буфер ключа на KEY_LEN байт, их сообщение — живой срез.
        let ok = unsafe {
            sys::SPAKE2_process_msg(
                self.ctx.as_ptr(),
                key.as_mut_ptr(),
                &mut len,
                key.len(),
                their_msg.as_ptr(),
                their_msg.len(),
            )
        };
        // Ключ короче KEY_LEN библиотека не выдаёт; проверка — на случай смены версии.
        if ok != 1 || len != KEY_LEN {
            return Err(Spake2Error);
        }
        Ok(key)
    }
}

impl Drop for Spake2 {
    fn drop(&mut self) {
        // SAFETY: ctx получен из SPAKE2_CTX_new, не NULL и освобождается
        // ровно один раз — здесь; после finish освобождение разрешено явно.
        unsafe { sys::SPAKE2_CTX_free(self.ctx.as_ptr()) }
    }
}

// SAFETY: контекст — обычная куча без привязки к потоку; доступ к нему
// только через &mut self/self, так что передача между потоками безопасна.
unsafe impl Send for Spake2 {}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(
        alice: (&str, &str, &str),
        bob: (&str, &str, &str),
    ) -> (
        Result<SharedKey, Spake2Error>,
        Result<SharedKey, Spake2Error>,
    ) {
        let (a, msg_a) = Spake2::start(Role::Alice, alice.0, alice.1, alice.2).unwrap();
        let (b, msg_b) = Spake2::start(Role::Bob, bob.0, bob.1, bob.2).unwrap();
        (a.finish(&msg_b), b.finish(&msg_a))
    }

    #[test]
    fn the_same_code_gives_the_same_key() {
        let (ka, kb) = run(("fa", "fb", "123456"), ("fb", "fa", "123456"));
        assert_eq!(ka.unwrap(), kb.unwrap());
    }

    #[test]
    fn a_different_code_gives_different_keys() {
        let (ka, kb) = run(("fa", "fb", "123456"), ("fb", "fa", "123457"));
        assert_ne!(ka.unwrap(), kb.unwrap());
    }

    #[test]
    fn swapped_or_foreign_names_give_different_keys() {
        // Bob считает себя «fa»: порядок имён не совпал.
        let (ka, kb) = run(("fa", "fb", "123456"), ("fa", "fb", "123456"));
        assert_ne!(ka.unwrap(), kb.unwrap());
        // Ретранслятор со своим сертификатом: Bob видит не тот отпечаток Alice.
        let (ka, kb) = run(("fa", "fb", "123456"), ("fb", "fm", "123456"));
        assert_ne!(ka.unwrap(), kb.unwrap());
    }

    #[test]
    fn every_run_is_fresh_and_garbage_is_refused() {
        let (_, m1) = Spake2::start(Role::Alice, "fa", "fb", "123456").unwrap();
        let (_, m2) = Spake2::start(Role::Alice, "fa", "fb", "123456").unwrap();
        assert_eq!(m1.len(), MAX_MSG);
        assert_ne!(m1, m2);
        let (b, _) = Spake2::start(Role::Bob, "fb", "fa", "123456").unwrap();
        assert_eq!(b.finish(&[1, 2, 3]), Err(Spake2Error));
    }
}
