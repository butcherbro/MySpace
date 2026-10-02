//! TLS for the LAN transport (ADR-0011 S3): self-signed device certificates,
//! pinned by SHA-256 fingerprint. There is no CA and no host name check: a
//! peer is exactly the holder of the private key whose certificate hashes to
//! the fingerprint stored at pairing time.
//!
//! - Server: TLS 1.3, client certificate REQUIRED. The handshake accepts any
//!   well-formed certificate whose holder proves possession of its key (the
//!   CertificateVerify signature is checked); authorization happens per
//!   request against `sync_peers` (`server.rs`), because `/pair` must accept a
//!   device that is not paired yet.
//! - Client: [`PinnedServerVerifier`] accepts only the pinned fingerprint;
//!   [`PairingServerVerifier`] (used by `/pair` only) accepts the first
//!   certificate it sees and records its fingerprint, which the pairing
//!   proofs then bind, and refuses any different certificate afterwards.

use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{DigitallySignedStruct, DistinguishedName, Error as TlsError, SignatureScheme};
use sha2::{Digest, Sha256};

use crate::domain::errors::WorkspaceError;

use super::pairing::hex_lower;
use super::peers::TransportIdentity;

fn tls_err(context: &str, e: impl std::fmt::Display) -> WorkspaceError {
    WorkspaceError::Database(format!("sync tls: {context}: {e}"))
}

/// The crypto provider every LAN config uses: aws-lc-rs, the one reqwest
/// already links. Explicit, so no process-wide default is needed.
pub fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::aws_lc_rs::default_provider())
}

/// Lowercase hex SHA-256 of a DER certificate.
pub fn fingerprint(der: &[u8]) -> String {
    hex_lower(&Sha256::digest(der))
}

/// [`fingerprint`] of the first certificate in a PEM string.
pub fn fingerprint_of_pem(pem: &str) -> Result<String, WorkspaceError> {
    let der = CertificateDer::from_pem_slice(pem.as_bytes()).map_err(|e| tls_err("cert", e))?;
    Ok(fingerprint(&der))
}

/// A fresh self-signed certificate (ECDSA P-256) for `device_id`: `(cert
/// PEM, PKCS#8 key PEM)`. The SAN is informational; nothing checks it.
pub fn generate_certificate(device_id: &str) -> Result<(String, String), WorkspaceError> {
    let certified = rcgen::generate_simple_self_signed(vec![format!("myspace-{device_id}")])
        .map_err(|e| tls_err("generate", e))?;
    Ok((certified.cert.pem(), certified.signing_key.serialize_pem()))
}

fn chain_and_key(
    identity: &TransportIdentity,
) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), WorkspaceError> {
    let cert = CertificateDer::from_pem_slice(identity.cert_pem.as_bytes())
        .map_err(|e| tls_err("cert", e))?;
    let key = PrivateKeyDer::from_pem_slice(identity.key_pem.as_bytes())
        .map_err(|e| tls_err("key", e))?;
    Ok((vec![cert], key))
}

/// Server config: TLS 1.3 only, client certificate required
/// ([`AnyClientCert`]), no ALPN (HTTP/1.1).
pub fn server_config(identity: &TransportIdentity) -> Result<rustls::ServerConfig, WorkspaceError> {
    let provider = provider();
    let (chain, key) = chain_and_key(identity)?;
    rustls::ServerConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| tls_err("server versions", e))?
        .with_client_cert_verifier(Arc::new(AnyClientCert { provider }))
        .with_single_cert(chain, key)
        .map_err(|e| tls_err("server cert", e))
}

/// Client config presenting this device's certificate and verifying the
/// server with `verifier`.
pub fn client_config(
    identity: &TransportIdentity,
    verifier: Arc<dyn ServerCertVerifier>,
) -> Result<rustls::ClientConfig, WorkspaceError> {
    let (chain, key) = chain_and_key(identity)?;
    rustls::ClientConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| tls_err("client versions", e))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_client_auth_cert(chain, key)
        .map_err(|e| tls_err("client cert", e))
}

fn verify12(
    provider: &CryptoProvider,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, TlsError> {
    verify_tls12_signature(
        message,
        cert,
        dss,
        &provider.signature_verification_algorithms,
    )
}

fn verify13(
    provider: &CryptoProvider,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, TlsError> {
    verify_tls13_signature(
        message,
        cert,
        dss,
        &provider.signature_verification_algorithms,
    )
}

/// Server side: requires a client certificate and checks the holder's
/// signature; WHO it is is decided per request against `sync_peers`.
#[derive(Debug)]
struct AnyClientCert {
    provider: Arc<CryptoProvider>,
}

impl ClientCertVerifier for AnyClientCert {
    fn offer_client_auth(&self) -> bool {
        true
    }

    fn client_auth_mandatory(&self) -> bool {
        true
    }

    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, TlsError> {
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify12(&self.provider, message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify13(&self.provider, message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Client side, paired peer: only the certificate whose SHA-256 is
/// `fingerprint` is accepted.
#[derive(Debug)]
pub struct PinnedServerVerifier {
    fingerprint: String,
    provider: Arc<CryptoProvider>,
}

impl PinnedServerVerifier {
    pub fn new(fingerprint: &str) -> Arc<Self> {
        Arc::new(Self {
            fingerprint: fingerprint.to_ascii_lowercase(),
            provider: provider(),
        })
    }
}

impl ServerCertVerifier for PinnedServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        if fingerprint(end_entity) == self.fingerprint {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(TlsError::General(
                "peer certificate does not match the paired fingerprint".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify12(&self.provider, message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify13(&self.provider, message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Client side, `/pair` only: trust on first use within ONE pairing
/// attempt. Records the first server certificate's fingerprint and refuses
/// any other one afterwards, so the fingerprint bound by the pairing proofs
/// is the one every request of the attempt talked to. The pairing code, not
/// this verifier, authenticates the peer.
#[derive(Debug)]
pub struct PairingServerVerifier {
    seen: Mutex<Option<String>>,
    /// When pairing with a discovered device: the fingerprint it advertised.
    expected: Option<String>,
    provider: Arc<CryptoProvider>,
}

impl PairingServerVerifier {
    pub fn new(expected: Option<&str>) -> Arc<Self> {
        Arc::new(Self {
            seen: Mutex::new(None),
            expected: expected.map(str::to_ascii_lowercase),
            provider: provider(),
        })
    }

    /// The fingerprint of the server certificate, once a handshake happened.
    pub fn seen(&self) -> Option<String> {
        self.seen.lock().ok().and_then(|s| s.clone())
    }
}

impl ServerCertVerifier for PairingServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        let fp = fingerprint(end_entity);
        if self.expected.as_ref().is_some_and(|e| *e != fp) {
            return Err(TlsError::General(
                "certificate differs from the advertised fingerprint".into(),
            ));
        }
        let mut seen = self
            .seen
            .lock()
            .map_err(|_| TlsError::General("verifier poisoned".into()))?;
        match seen.as_ref() {
            Some(first) if *first != fp => Err(TlsError::General(
                "peer certificate changed during pairing".into(),
            )),
            Some(_) => Ok(ServerCertVerified::assertion()),
            None => {
                *seen = Some(fp);
                Ok(ServerCertVerified::assertion())
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify12(&self.provider, message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify13(&self.provider, message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_generated_certificate_round_trips_and_has_a_stable_fingerprint() {
        let (cert, key) = generate_certificate("dev-1").unwrap();
        let fp = fingerprint_of_pem(&cert).unwrap();
        assert_eq!(fp.len(), 64);
        assert_eq!(fp, fingerprint_of_pem(&cert).unwrap());
        let identity = TransportIdentity {
            device_id: "dev-1".into(),
            cert_pem: cert,
            key_pem: key,
            fingerprint: fp.clone(),
        };
        server_config(&identity).unwrap();
        client_config(&identity, PinnedServerVerifier::new(&fp)).unwrap();
        let (other, _) = generate_certificate("dev-1").unwrap();
        assert_ne!(fingerprint_of_pem(&other).unwrap(), fp);
    }
}
