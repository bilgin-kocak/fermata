//! Fermata attestor (`fermata-attest`): proves a vendor's HTTPS response with TLSNotary, binds the
//! presentation to an on-chain hold, evaluates the service's delivery predicate and signs the
//! EIP-712 verdict that `FermataEscrow.settle` accepts.
//!
//! TLSNotary plumbing is ported from Bilgin's WebProof (github.com/bilgin-kocak/webproof-solana,
//! Apache-2.0) and the upstream `attestation` example at tlsn v0.1.0-alpha.15, via the Milestone S
//! spike (`spikes/proof-path`).

pub mod chain;
pub mod config;
pub mod eip712;
pub mod hashes;
pub mod http_raw;
pub mod notary;
pub mod predicate;
pub mod prove;
pub mod serve;
pub mod tunnel;
pub mod verify;
