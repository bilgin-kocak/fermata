//! What the verifier reads from the chain before signing (binding checks 1–5): the hold for a
//! callId and the service it belongs to, via `FermataEscrow.getHold` / `getService`, plus the
//! latest block timestamp. Hand-rolled JSON-RPC `eth_call` + ABI decoding (no alloy): both views
//! return static tuples, so decoding is fixed-offset 32-byte words.

use std::{collections::HashMap, future::Future, sync::Arc};

use anyhow::{Context, Result, anyhow, bail, ensure};
use http_body_util::{BodyExt, Full};
use hyper::{Request, body::Bytes};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::{net::TcpStream, sync::Mutex};
use tokio_rustls::{
    TlsConnector,
    rustls::{ClientConfig, RootCertStore, pki_types::ServerName},
};

use crate::{eip712::keccak, hashes::hex0x};

/// `FermataEscrow.Status`.
pub const STATUS_HELD: u8 = 1;

/// `FermataEscrow.getHold(callId)` (`HoldView`). `amount` and `deadline` are 0 unless Held.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HoldInfo {
    pub agent: [u8; 20],
    pub service_id: [u8; 32],
    pub request_hash: [u8; 32],
    pub amount: [u8; 32],
    pub held_at: u64,
    pub deadline: u64,
    pub fee_bps: u16,
    pub status: u8,
}

/// `FermataEscrow.getService(serviceId)`. `token == 0` means unknown service.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ServiceInfo {
    pub owner: [u8; 20],
    pub settlement_window: u32,
    pub payout: [u8; 20],
    pub token: [u8; 20],
    pub verifier: [u8; 20],
    pub price_per_call: [u8; 32],
    pub predicate_hash: [u8; 32],
    pub origin_hash: [u8; 32],
    pub notary_key_hash: [u8; 32],
}

/// Read-only chain access the verifier needs. `RpcChain` in production, `MockChain` in tests.
pub trait ChainView: Send + Sync {
    fn hold(&self, call_id: [u8; 32]) -> impl Future<Output = Result<HoldInfo>> + Send;
    fn service(&self, service_id: [u8; 32]) -> impl Future<Output = Result<ServiceInfo>> + Send;
    fn latest_timestamp(&self) -> impl Future<Output = Result<u64>> + Send;
}

// ------------------------------------------------------------------------------------ ABI decoding

fn selector(sig: &str) -> [u8; 4] {
    keccak(sig.as_bytes())[..4].try_into().unwrap()
}

fn word(data: &[u8], i: usize) -> Result<[u8; 32]> {
    data.get(i * 32..(i + 1) * 32)
        .map(|w| w.try_into().unwrap())
        .ok_or_else(|| anyhow!("return data too short: {} bytes, need word {i}", data.len()))
}

fn addr(w: &[u8; 32]) -> Result<[u8; 20]> {
    ensure!(
        w[..12].iter().all(|b| *b == 0),
        "dirty address word {}",
        hex0x(w)
    );
    Ok(w[12..].try_into().unwrap())
}

fn uint(w: &[u8; 32], bits: u32) -> Result<u64> {
    let bytes = (bits / 8) as usize;
    ensure!(
        w[..32 - bytes].iter().all(|b| *b == 0),
        "value exceeds uint{bits}: {}",
        hex0x(w)
    );
    let mut buf = [0u8; 8];
    buf[8 - bytes..].copy_from_slice(&w[32 - bytes..]);
    Ok(u64::from_be_bytes(buf))
}

pub fn get_hold_calldata(call_id: &[u8; 32]) -> Vec<u8> {
    [selector("getHold(bytes32)").as_slice(), call_id].concat()
}

pub fn get_service_calldata(service_id: &[u8; 32]) -> Vec<u8> {
    [selector("getService(bytes32)").as_slice(), service_id].concat()
}

pub fn decode_hold(data: &[u8]) -> Result<HoldInfo> {
    Ok(HoldInfo {
        agent: addr(&word(data, 0)?)?,
        service_id: word(data, 1)?,
        request_hash: word(data, 2)?,
        amount: word(data, 3)?,
        held_at: uint(&word(data, 4)?, 64)?,
        deadline: uint(&word(data, 5)?, 64)?,
        fee_bps: uint(&word(data, 6)?, 16)? as u16,
        status: uint(&word(data, 7)?, 8)? as u8,
    })
}

pub fn decode_service(data: &[u8]) -> Result<ServiceInfo> {
    Ok(ServiceInfo {
        owner: addr(&word(data, 0)?)?,
        settlement_window: uint(&word(data, 1)?, 32)? as u32,
        payout: addr(&word(data, 2)?)?,
        token: addr(&word(data, 3)?)?,
        verifier: addr(&word(data, 4)?)?,
        price_per_call: word(data, 5)?,
        predicate_hash: word(data, 6)?,
        origin_hash: word(data, 7)?,
        notary_key_hash: word(data, 8)?,
    })
}

// ---------------------------------------------------------------------------------------- JSON-RPC

/// JSON-RPC client for one escrow deployment. Plain `http://` (Anvil) or `https://` (Moderato,
/// Mozilla roots). Talks to the RPC directly; no HTTP proxy support.
#[derive(Clone)]
pub struct RpcChain {
    pub rpc: String,
    pub escrow: [u8; 20],
    pub chain_id: u64,
    tls: TlsConnector,
}

impl RpcChain {
    /// Connects, checks the chain id and that the escrow has code.
    pub async fn connect(rpc: &str, escrow: [u8; 20]) -> Result<Self> {
        let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
        let roots = RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        let tls = TlsConnector::from(Arc::new(
            ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        ));
        let mut chain = Self {
            rpc: rpc.to_string(),
            escrow,
            chain_id: 0,
            tls,
        };
        let id = chain.call("eth_chainId", json!([])).await?;
        chain.chain_id = parse_quantity(&id)?;
        let code = chain
            .call("eth_getCode", json!([hex0x(&escrow), "latest"]))
            .await?;
        if code.as_str().unwrap_or("0x").len() <= 2 {
            bail!("no contract code at escrow {} on {rpc}", hex0x(&escrow));
        }
        Ok(chain)
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let uri: hyper::Uri = self
            .rpc
            .parse()
            .with_context(|| format!("bad RPC url {}", self.rpc))?;
        let https = match uri.scheme_str() {
            Some("https") => true,
            Some("http") => false,
            _ => bail!("RPC url must be http(s): {}", self.rpc),
        };
        let host = uri.host().context("RPC url has no host")?.to_string();
        let port = uri.port_u16().unwrap_or(if https { 443 } else { 80 });
        let body = serde_json::to_vec(
            &json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}),
        )?;
        let path = uri
            .path_and_query()
            .map(|p| p.as_str())
            .unwrap_or("/")
            .to_string();
        let request = Request::post(path)
            .header("host", &host)
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(body)))?;

        let tcp = TcpStream::connect((host.as_str(), port))
            .await
            .with_context(|| format!("connecting to {}", self.rpc))?;
        let response = if https {
            let name = ServerName::try_from(host.clone())?;
            let tls = self.tls.connect(name, tcp).await?;
            let (mut sender, conn) =
                hyper::client::conn::http1::handshake(TokioIo::new(tls)).await?;
            tokio::spawn(conn);
            sender.send_request(request).await?
        } else {
            let (mut sender, conn) =
                hyper::client::conn::http1::handshake(TokioIo::new(tcp)).await?;
            tokio::spawn(conn);
            sender.send_request(request).await?
        };
        let status = response.status();
        let bytes = response.into_body().collect().await?.to_bytes();
        ensure!(
            status.is_success(),
            "RPC {method} HTTP {status}: {}",
            String::from_utf8_lossy(&bytes)
        );
        let v: Value = serde_json::from_slice(&bytes)?;
        if let Some(err) = v.get("error") {
            bail!("RPC {method} error: {err}");
        }
        v.get("result")
            .cloned()
            .context("RPC response without result")
    }

    async fn eth_call(&self, data: Vec<u8>) -> Result<Vec<u8>> {
        let result = self
            .call(
                "eth_call",
                json!([{"to": hex0x(&self.escrow), "data": hex0x(&data)}, "latest"]),
            )
            .await?;
        Ok(hex::decode(
            result
                .as_str()
                .context("eth_call result not a string")?
                .trim_start_matches("0x"),
        )?)
    }
}

fn parse_quantity(v: &Value) -> Result<u64> {
    let s = v.as_str().context("quantity is not a string")?;
    Ok(u64::from_str_radix(s.trim_start_matches("0x"), 16)?)
}

impl ChainView for RpcChain {
    async fn hold(&self, call_id: [u8; 32]) -> Result<HoldInfo> {
        decode_hold(&self.eth_call(get_hold_calldata(&call_id)).await?)
    }

    async fn service(&self, service_id: [u8; 32]) -> Result<ServiceInfo> {
        decode_service(&self.eth_call(get_service_calldata(&service_id)).await?)
    }

    async fn latest_timestamp(&self) -> Result<u64> {
        let block = self
            .call("eth_getBlockByNumber", json!(["latest", false]))
            .await?;
        parse_quantity(block.get("timestamp").context("block without timestamp")?)
    }
}

/// In-memory chain for tests and offline tooling.
#[derive(Default)]
pub struct MockChain {
    pub holds: Mutex<HashMap<[u8; 32], HoldInfo>>,
    pub services: Mutex<HashMap<[u8; 32], ServiceInfo>>,
    pub now: Mutex<u64>,
}

impl ChainView for MockChain {
    async fn hold(&self, call_id: [u8; 32]) -> Result<HoldInfo> {
        Ok(self
            .holds
            .lock()
            .await
            .get(&call_id)
            .cloned()
            .unwrap_or_default())
    }

    async fn service(&self, service_id: [u8; 32]) -> Result<ServiceInfo> {
        Ok(self
            .services
            .lock()
            .await
            .get(&service_id)
            .cloned()
            .unwrap_or_default())
    }

    async fn latest_timestamp(&self) -> Result<u64> {
        Ok(*self.now.lock().await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selectors() {
        assert_eq!(
            hex::encode(selector("getHold(bytes32)")),
            hex::encode(&keccak(b"getHold(bytes32)")[..4])
        );
        assert_eq!(get_hold_calldata(&[7; 32]).len(), 36);
    }

    #[test]
    fn decodes_hold_words() {
        let mut data = vec![0u8; 8 * 32];
        data[31] = 0xAA; // agent …aa
        data[32..64].copy_from_slice(&[0x22; 32]);
        data[64..96].copy_from_slice(&[0x33; 32]);
        data[127] = 100; // amount
        data[152..160].copy_from_slice(&1_700_000_000u64.to_be_bytes());
        data[184..192].copy_from_slice(&1_700_000_030u64.to_be_bytes());
        data[223] = 50;
        data[255] = STATUS_HELD;
        let h = decode_hold(&data).unwrap();
        assert_eq!(h.agent[19], 0xAA);
        assert_eq!(h.service_id, [0x22; 32]);
        assert_eq!(
            (h.held_at, h.deadline, h.fee_bps, h.status),
            (1_700_000_000, 1_700_000_030, 50, STATUS_HELD)
        );
        data[200] = 1; // fee word overflows uint16
        assert!(decode_hold(&data).is_err());
        assert!(decode_hold(&data[..200]).is_err());
    }
}
