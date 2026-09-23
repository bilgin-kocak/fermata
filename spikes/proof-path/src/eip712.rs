//! EIP-712 `Verdict` hashing and secp256k1 signing (hand-rolled; no alloy).
//!
//! Verdict(bytes32 callId,bytes32 serviceId,bytes32 requestHash,bytes32 predicateHash,
//!         uint8 outcome,bytes32 presentationHash,bytes32 responseHash,uint64 issuedAt)
//! EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
//!   = ("Fermata", "1", chainId, escrow)

use k256::ecdsa::SigningKey;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

pub const VERDICT_TYPE: &str = "Verdict(bytes32 callId,bytes32 serviceId,bytes32 requestHash,bytes32 predicateHash,uint8 outcome,bytes32 presentationHash,bytes32 responseHash,uint64 issuedAt)";
pub const DOMAIN_TYPE: &str =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

pub const OUTCOME_DELIVERED: u8 = 1;
pub const OUTCOME_FAILED: u8 = 2;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Verdict {
    #[serde(with = "hex32")]
    pub call_id: [u8; 32],
    #[serde(with = "hex32")]
    pub service_id: [u8; 32],
    #[serde(with = "hex32")]
    pub request_hash: [u8; 32],
    #[serde(with = "hex32")]
    pub predicate_hash: [u8; 32],
    pub outcome: u8,
    #[serde(with = "hex32")]
    pub presentation_hash: [u8; 32],
    #[serde(with = "hex32")]
    pub response_hash: [u8; 32],
    pub issued_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Domain {
    pub chain_id: u64,
    #[serde(with = "hex20")]
    pub verifying_contract: [u8; 20],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Signature {
    #[serde(with = "hex32")]
    pub r: [u8; 32],
    #[serde(with = "hex32")]
    pub s: [u8; 32],
    pub v: u8,
}

pub fn keccak(bytes: &[u8]) -> [u8; 32] {
    Keccak256::digest(bytes).into()
}

fn word_u64(x: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&x.to_be_bytes());
    w
}

fn word_addr(a: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

pub fn domain_separator(d: &Domain) -> [u8; 32] {
    let mut buf = Vec::with_capacity(5 * 32);
    buf.extend_from_slice(&keccak(DOMAIN_TYPE.as_bytes()));
    buf.extend_from_slice(&keccak(b"Fermata"));
    buf.extend_from_slice(&keccak(b"1"));
    buf.extend_from_slice(&word_u64(d.chain_id));
    buf.extend_from_slice(&word_addr(&d.verifying_contract));
    keccak(&buf)
}

pub fn struct_hash(v: &Verdict) -> [u8; 32] {
    let mut buf = Vec::with_capacity(9 * 32);
    buf.extend_from_slice(&keccak(VERDICT_TYPE.as_bytes()));
    buf.extend_from_slice(&v.call_id);
    buf.extend_from_slice(&v.service_id);
    buf.extend_from_slice(&v.request_hash);
    buf.extend_from_slice(&v.predicate_hash);
    buf.extend_from_slice(&word_u64(v.outcome as u64));
    buf.extend_from_slice(&v.presentation_hash);
    buf.extend_from_slice(&v.response_hash);
    buf.extend_from_slice(&word_u64(v.issued_at));
    keccak(&buf)
}

pub fn digest(d: &Domain, v: &Verdict) -> [u8; 32] {
    let mut buf = Vec::with_capacity(2 + 64);
    buf.extend_from_slice(b"\x19\x01");
    buf.extend_from_slice(&domain_separator(d));
    buf.extend_from_slice(&struct_hash(v));
    keccak(&buf)
}

/// Deterministic (RFC 6979) low-s recoverable signature; `v = 27 + recid`.
pub fn sign(key: &[u8; 32], digest: &[u8; 32]) -> anyhow::Result<Signature> {
    let sk = SigningKey::from_slice(key)?;
    let (sig, recid) = sk.sign_prehash_recoverable(digest)?;
    let bytes = sig.to_bytes();
    let mut r = [0u8; 32];
    let mut s = [0u8; 32];
    r.copy_from_slice(&bytes[..32]);
    s.copy_from_slice(&bytes[32..]);
    Ok(Signature { r, s, v: 27 + recid.to_byte() })
}

pub fn signer_address(key: &[u8; 32]) -> anyhow::Result<[u8; 20]> {
    let sk = SigningKey::from_slice(key)?;
    let pk = sk.verifying_key().to_encoded_point(false);
    let h = keccak(&pk.as_bytes()[1..]);
    let mut a = [0u8; 20];
    a.copy_from_slice(&h[12..]);
    Ok(a)
}

/// The fixed cross-check vector shared with the Foundry test.
pub fn test_vector() -> (Domain, Verdict, [u8; 32]) {
    let mut key = [0u8; 32];
    key[31] = 1;
    let mut escrow = [0u8; 20];
    escrow[18] = 0x0F;
    escrow[19] = 0xe1;
    (
        Domain { chain_id: 42431, verifying_contract: escrow },
        Verdict {
            call_id: [0x11; 32],
            service_id: [0x22; 32],
            request_hash: [0x33; 32],
            predicate_hash: [0x44; 32],
            outcome: OUTCOME_DELIVERED,
            presentation_hash: [0x55; 32],
            response_hash: [0x66; 32],
            issued_at: 1_700_000_000,
        },
        key,
    )
}

mod hex32 {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(b: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("0x{}", hex::encode(b)))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        let s = String::deserialize(d)?;
        let v = hex::decode(s.trim_start_matches("0x")).map_err(serde::de::Error::custom)?;
        v.try_into().map_err(|_| serde::de::Error::custom("expected 32 bytes"))
    }
}

mod hex20 {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(b: &[u8; 20], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("0x{}", hex::encode(b)))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 20], D::Error> {
        let s = String::deserialize(d)?;
        let v = hex::decode(s.trim_start_matches("0x")).map_err(serde::de::Error::custom)?;
        v.try_into().map_err(|_| serde::de::Error::custom("expected 20 bytes"))
    }
}
