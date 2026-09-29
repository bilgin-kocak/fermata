//! `fermata-attest serve`: the attestor's HTTP API for the gateway (Milestone 3).
//!
//!   GET  /healthz                     → { ok, signer, escrow, chainId, notary, predicates }
//!   POST /v1/prove   ProveBody        → prove only; stores storage/presentations/<callId>.tlsn
//!   POST /v1/verify  { callId }       → verify the stored presentation → signed verdict
//!   POST /v1/attest  ProveBody        → prove, then verify → { prove, verdict }
//!   GET  /v1/presentations/<callId>   → the presentation bytes (for anyone to re-verify offline)
//!
//! Errors: 400 bad input; 422 { check, detail } when a binding check fails (no verdict);
//! 502 { error: "no-transcript" } when proving failed — never a verdict without a presentation.
//! Proving is serialised: concurrent MPC sessions deadlock on small machines.

use std::{
    collections::HashMap, convert::Infallible, net::SocketAddr, path::PathBuf, sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, anyhow};
use http_body_util::{BodyExt, Full};
use hyper::{Method, Request, Response, StatusCode, body::Bytes, service::service_fn};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use serde_json::{Value, json};
use tlsn::webpki::CertificateDer;
use tokio::{net::TcpListener, sync::Mutex};
use tracing::{error, info};

use crate::{
    chain::RpcChain,
    config::PredicateStore,
    eip712::{self, Domain},
    hashes::{Origin, hex0x, parse_hex32},
    prove::{self, ProveOutput, ProveRequest},
    verify::{self, VerifyError},
};

pub struct State {
    pub chain: RpcChain,
    pub roots: Vec<CertificateDer>,
    pub notary: String,
    pub predicates: PredicateStore,
    pub key: [u8; 32],
    pub storage: PathBuf,
    /// `host:port` → address to dial (like curl --resolve).
    pub resolve: HashMap<String, String>,
    pub attempts: u32,
    pub attempt_timeout: Duration,
    pub max_sent: usize,
    pub max_recv: usize,
    pub prove_lock: Mutex<()>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProveBody {
    call_id: String,
    /// Full upstream URL, e.g. https://vendor.fermata.test:8443/v1/quote?symbol=BTC-USD
    url: String,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: String,
}

fn default_method() -> String {
    "GET".into()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyBody {
    call_id: String,
}

/// Splits `https://host[:port]/path?query` into the origin and the origin-form target.
pub fn split_url(url: &str) -> Result<(Origin, String)> {
    let rest = url
        .strip_prefix("https://")
        .context("upstream url must be https://")?;
    let (authority, target) = match rest.find(['/', '?']) {
        Some(i) if rest.as_bytes()[i] == b'/' => (&rest[..i], rest[i..].to_string()),
        Some(i) => (&rest[..i], format!("/{}", &rest[i..])),
        None => (rest, "/".to_string()),
    };
    Ok((Origin::parse(&format!("https://{authority}"))?, target))
}

impl State {
    fn presentation_path(&self, call_id: &[u8; 32]) -> PathBuf {
        self.storage.join(format!("{}.tlsn", hex0x(call_id)))
    }

    async fn prove(
        &self,
        body: &ProveBody,
    ) -> Result<(ProveOutput, [u8; 32]), (StatusCode, Value)> {
        let bad = |e: anyhow::Error| {
            (
                StatusCode::BAD_REQUEST,
                json!({ "error": format!("{e:#}") }),
            )
        };
        let call_id = parse_hex32(&body.call_id).map_err(bad)?;
        let (origin, target) = split_url(&body.url).map_err(bad)?;
        let authority = format!("{}:{}", origin.host, origin.port);
        let request = ProveRequest {
            notary: self.notary.clone(),
            connect: self.resolve.get(&authority).cloned().unwrap_or(authority),
            origin,
            roots: self.roots.clone(),
            method: body.method.clone(),
            target,
            headers: body
                .headers
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            body: body.body.clone().into_bytes(),
            call_id,
            max_sent: self.max_sent,
            max_recv: self.max_recv,
            redact: prove::default_redactions(),
            setup_timeout: self.attempt_timeout / 3,
        };
        let _guard = self.prove_lock.lock().await;
        let out = prove::prove(&request, self.attempts, self.attempt_timeout)
            .await
            .map_err(|e| {
                error!("callId {}: no transcript: {e:#}", body.call_id);
                (
                    StatusCode::BAD_GATEWAY,
                    json!({ "error": "no-transcript", "detail": format!("{e:#}") }),
                )
            })?;
        let path = self.presentation_path(&call_id);
        tokio::fs::create_dir_all(&self.storage)
            .await
            .map_err(|e| internal(e.into()))?;
        tokio::fs::write(&path, &out.presentation)
            .await
            .map_err(|e| internal(e.into()))?;
        info!(
            "callId {}: proved in {} ms, {} bytes → {}",
            body.call_id,
            out.prove_ms,
            out.presentation_bytes,
            path.display()
        );
        Ok((out, call_id))
    }

    async fn verify(&self, call_id: [u8; 32]) -> Result<Value, (StatusCode, Value)> {
        let bytes = tokio::fs::read(self.presentation_path(&call_id))
            .await
            .map_err(|_| {
                (
                    StatusCode::NOT_FOUND,
                    json!({ "error": "no presentation stored for this callId" }),
                )
            })?;
        let domain = Domain {
            chain_id: self.chain.chain_id,
            verifying_contract: self.chain.escrow,
        };
        let issued_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        match verify::attest(
            &bytes,
            call_id,
            &self.roots,
            &self.chain,
            |h| self.predicates.get(h),
            &domain,
            &self.key,
            issued_at,
        )
        .await
        {
            Ok(signed) => {
                Ok(json!({ "presentationHash": hex0x(&eip712::keccak(&bytes)), "verdict": signed }))
            }
            Err(e) => match e.downcast_ref::<VerifyError>() {
                Some(v) => Err((
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({ "error": "binding-check-failed", "check": v.check, "detail": v.detail }),
                )),
                None => Err(internal(e)),
            },
        }
    }
}

fn internal(e: anyhow::Error) -> (StatusCode, Value) {
    error!("{e:#}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({ "error": format!("{e:#}") }),
    )
}

fn reply(status: StatusCode, body: Value) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(serde_json::to_vec(&body).unwrap())))
        .unwrap()
}

async fn parse<T: for<'de> Deserialize<'de>>(
    req: Request<hyper::body::Incoming>,
) -> Result<T, (StatusCode, Value)> {
    let bytes = req
        .into_body()
        .collect()
        .await
        .map_err(|e| internal(e.into()))?
        .to_bytes();
    serde_json::from_slice(&bytes).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            json!({ "error": format!("bad JSON body: {e}") }),
        )
    })
}

async fn route(
    state: Arc<State>,
    req: Request<hyper::body::Incoming>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let path = req.uri().path().to_string();
    let result: Result<Value, (StatusCode, Value)> = match (req.method().clone(), path.as_str()) {
        (Method::GET, "/healthz") => Ok(json!({
            "ok": true,
            "signer": eip712::signer_address(&state.key).map(|a| hex0x(&a)).unwrap_or_default(),
            "escrow": hex0x(&state.chain.escrow),
            "chainId": state.chain.chain_id,
            "notary": state.notary,
            "predicates": state.predicates.len(),
        })),
        (Method::POST, "/v1/prove") => match parse::<ProveBody>(req).await {
            Ok(body) => state.prove(&body).await.map(|(out, call_id)| {
                json!({ "prove": out, "presentationHash": hex0x(&eip712::keccak(&out.presentation)), "callId": hex0x(&call_id) })
            }),
            Err(e) => Err(e),
        },
        (Method::POST, "/v1/verify") => match parse::<VerifyBody>(req).await {
            Ok(body) => match parse_hex32(&body.call_id) {
                Ok(call_id) => state.verify(call_id).await,
                Err(e) => Err((StatusCode::BAD_REQUEST, json!({ "error": format!("{e:#}") }))),
            },
            Err(e) => Err(e),
        },
        (Method::POST, "/v1/attest") => match parse::<ProveBody>(req).await {
            Ok(body) => match state.prove(&body).await {
                Ok((out, call_id)) => state.verify(call_id).await.map(|mut v| {
                    v["prove"] = serde_json::to_value(&out).unwrap();
                    v
                }),
                Err(e) => Err(e),
            },
            Err(e) => Err(e),
        },
        (Method::GET, p) if p.starts_with("/v1/presentations/") => {
            let id = p.trim_start_matches("/v1/presentations/").trim_end_matches(".tlsn");
            return Ok(match parse_hex32(id) {
                Ok(call_id) => match tokio::fs::read(state.presentation_path(&call_id)).await {
                    Ok(bytes) => Response::builder()
                        .header("content-type", "application/octet-stream")
                        .body(Full::new(Bytes::from(bytes)))
                        .unwrap(),
                    Err(_) => reply(StatusCode::NOT_FOUND, json!({ "error": "not found" })),
                },
                Err(e) => reply(StatusCode::BAD_REQUEST, json!({ "error": format!("{e:#}") })),
            });
        }
        _ => Err((StatusCode::NOT_FOUND, json!({ "error": "not found" }))),
    };
    Ok(match result {
        Ok(v) => reply(StatusCode::OK, v),
        Err((status, v)) => reply(status, v),
    })
}

pub async fn run(addr: SocketAddr, state: State) -> Result<()> {
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding {addr}"))?;
    info!("attestor listening on http://{addr}");
    let state = Arc::new(state);
    loop {
        let (socket, _) = listener.accept().await?;
        let state = state.clone();
        tokio::spawn(async move {
            let service = service_fn(move |req| route(state.clone(), req));
            if let Err(e) = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(socket), service)
                .await
            {
                error!("connection error: {e}");
            }
        });
    }
    #[allow(unreachable_code)]
    Err(anyhow!("listener closed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_urls() {
        let (o, t) = split_url("https://Vendor.Fermata.Test:8443/v1/quote?symbol=BTC-USD").unwrap();
        assert_eq!(
            (o.canonical().as_str(), t.as_str()),
            (
                "https://vendor.fermata.test:8443",
                "/v1/quote?symbol=BTC-USD"
            )
        );
        let (o, t) = split_url("https://api.example.com?x=1").unwrap();
        assert_eq!((o.port, t.as_str()), (443, "/?x=1"));
        assert_eq!(split_url("https://a.b").unwrap().1, "/");
        assert!(split_url("http://a.b/").is_err());
    }
}
