//! Fermata Milestone S, probe 1 (throwaway spike code).
//!
//! Shared pieces for the `notary`, `prove` and `verify` binaries.
//! The TLSNotary plumbing is ported from Bilgin's WebProof project
//! (https://github.com/bilgin-kocak/webproof-solana, Apache-2.0) and the
//! upstream `attestation` example at tlsn v0.1.0-alpha.15.

pub mod eip712;
pub mod http_raw;
pub mod predicate;

use sha2::{Digest, Sha256};

/// `requestHash = sha256(serviceId ‖ METHOD ‖ request-target ‖ sha256(body))`, no separators.
/// `serviceId` is 32 raw bytes, `method` upper-case ASCII, `target` verbatim from the request
/// line (origin-form, including `?query`), `body` the raw bytes as sent (empty body allowed).
pub fn request_hash(service_id: &[u8; 32], method: &str, target: &str, body: &[u8]) -> [u8; 32] {
    let body_hash = Sha256::digest(body);
    let mut h = Sha256::new();
    h.update(service_id);
    h.update(method.to_ascii_uppercase().as_bytes());
    h.update(target.as_bytes());
    h.update(body_hash);
    h.finalize().into()
}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

pub fn parse_hex32(s: &str) -> anyhow::Result<[u8; 32]> {
    let v = hex::decode(s.trim_start_matches("0x"))?;
    anyhow::ensure!(v.len() == 32, "expected 32 bytes, got {}", v.len());
    Ok(v.try_into().unwrap())
}

pub fn parse_hex20(s: &str) -> anyhow::Result<[u8; 20]> {
    let v = hex::decode(s.trim_start_matches("0x"))?;
    anyhow::ensure!(v.len() == 20, "expected 20 bytes, got {}", v.len());
    Ok(v.try_into().unwrap())
}

pub fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}
