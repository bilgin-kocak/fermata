//! Loading trust roots, keys and the content-addressed predicate store.

use std::{collections::HashMap, path::Path};

use anyhow::{Context, Result, anyhow};
use tlsn::webpki::CertificateDer;

use crate::hashes::{parse_hex32, predicate_hash};

/// All certificates in a PEM file (a vendor's dev CA, or a bundle).
pub fn load_roots(path: &Path) -> Result<Vec<CertificateDer>> {
    let pem = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let text = String::from_utf8_lossy(&pem);
    let mut out = Vec::new();
    for block in text
        .split("-----END CERTIFICATE-----")
        .filter(|b| b.contains("-----BEGIN CERTIFICATE-----"))
    {
        let block = format!("{block}-----END CERTIFICATE-----\n");
        out.push(
            CertificateDer::from_pem_slice(block.as_bytes())
                .map_err(|_| anyhow!("bad PEM in {}", path.display()))?,
        );
    }
    anyhow::ensure!(!out.is_empty(), "no certificate in {}", path.display());
    Ok(out)
}

/// The trust roots for vendor certificates: the PEM files in `ca` (dev CAs), plus Mozilla's root
/// program when `mozilla` is set (real vendors). At least one source is required.
pub fn trust_roots(ca: &[std::path::PathBuf], mozilla: bool) -> Result<Vec<CertificateDer>> {
    let mut roots = Vec::new();
    for path in ca {
        roots.extend(load_roots(path)?);
    }
    if mozilla {
        roots.extend(tlsn::webpki::RootCertStore::mozilla().roots);
    }
    anyhow::ensure!(
        !roots.is_empty(),
        "no trust roots: pass --ca <pem> and/or --roots mozilla"
    );
    Ok(roots)
}

/// A 32-byte hex key from an environment variable.
pub fn key_from_env(var: &str) -> Result<[u8; 32]> {
    parse_hex32(&std::env::var(var).with_context(|| format!("{var} is not set"))?)
        .with_context(|| format!("{var} is not a 32-byte hex key"))
}

/// Predicates by sha256 of their exact bytes: a directory of `*.json` files, or single files.
#[derive(Clone, Debug, Default)]
pub struct PredicateStore {
    by_hash: HashMap<[u8; 32], Vec<u8>>,
}

impl PredicateStore {
    pub fn load(paths: &[impl AsRef<Path>]) -> Result<Self> {
        let mut store = Self::default();
        for p in paths {
            let p = p.as_ref();
            if p.is_dir() {
                for entry in std::fs::read_dir(p)? {
                    let path = entry?.path();
                    if path.extension().is_some_and(|e| e == "json") {
                        store.add(std::fs::read(&path)?);
                    }
                }
            } else {
                store.add(std::fs::read(p).with_context(|| format!("reading {}", p.display()))?);
            }
        }
        Ok(store)
    }

    pub fn add(&mut self, bytes: Vec<u8>) -> [u8; 32] {
        let h = predicate_hash(&bytes);
        self.by_hash.insert(h, bytes);
        h
    }

    pub fn get(&self, hash: &[u8; 32]) -> Option<Vec<u8>> {
        self.by_hash.get(hash).cloned()
    }

    pub fn len(&self) -> usize {
        self.by_hash.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_hash.is_empty()
    }
}
