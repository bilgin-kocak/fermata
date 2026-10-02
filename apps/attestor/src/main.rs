//! `fermata-attest notary | prove | verify [--offline] | serve | hashes`

use std::{collections::HashMap, net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use clap::{Args, Parser, Subcommand};
use serde_json::json;
use tokio::net::TcpListener;

use fermata_attest::{
    chain::RpcChain,
    config::{PredicateStore, trust_roots},
    eip712::{self, Domain},
    hashes::{Origin, hex0x, notary_key_hash, parse_hex20, parse_hex32, predicate_hash},
    notary,
    predicate::Predicate,
    prove::{self, ProveRequest},
    serve::{self, State, split_url},
    tunnel::Proxy,
    verify,
};

#[derive(Parser)]
#[command(
    name = "fermata-attest",
    version,
    about = "Fermata attestor: TLSNotary prove / verify / sign"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the notary (TCP, one MPC session per connection).
    Notary {
        #[arg(long, default_value = "127.0.0.1:7047")]
        listen: String,
        /// PEM with the CA(s) of the vendors it may notarize (repeatable).
        #[arg(long)]
        ca: Vec<PathBuf>,
        /// `mozilla`: also trust Mozilla's root program (real vendors such as registry.npmjs.org).
        #[arg(long, value_parser = ["mozilla"])]
        roots: Option<String>,
        /// 32-byte hex signing key.
        #[arg(long, env = "NOTARY_PRIVATE_KEY", hide_env_values = true)]
        key: String,
        #[arg(long, default_value_t = 120)]
        timeout_secs: u64,
    },
    /// Prove one request to the vendor and write the presentation.
    Prove {
        #[command(flatten)]
        net: Net,
        /// Upstream URL, e.g. https://vendor.fermata.test:8443/v1/quote?symbol=BTC-USD
        #[arg(long)]
        url: String,
        #[arg(long, default_value = "GET")]
        method: String,
        /// Request header `name: value` (repeatable).
        #[arg(long = "header", short = 'H')]
        headers: Vec<String>,
        /// Request body, or @file.
        #[arg(long, default_value = "")]
        body: String,
        #[arg(long)]
        call_id: String,
        #[arg(long)]
        out: PathBuf,
    },
    /// Verify a presentation, run the binding checks and the predicate, sign the verdict.
    Verify {
        #[arg(long)]
        presentation: PathBuf,
        /// PEM with the vendor CA(s) that the server certificate must chain to (repeatable).
        #[arg(long)]
        ca: Vec<PathBuf>,
        /// `mozilla`: also trust Mozilla's root program (real vendors such as registry.npmjs.org).
        #[arg(long, value_parser = ["mozilla"])]
        roots: Option<String>,
        #[arg(long)]
        call_id: String,
        /// Predicate file(s) or directories (content-addressed by sha256).
        #[arg(long = "predicate", required = true)]
        predicates: Vec<PathBuf>,
        /// Re-check without chain access or signing key: recompute every verdict field and compare
        /// with any expected values given below.
        #[arg(long)]
        offline: bool,
        #[arg(long, env = "TEMPO_RPC_URL")]
        rpc: Option<String>,
        #[arg(long, env = "FERMATA_ESCROW")]
        escrow: Option<String>,
        #[arg(long, env = "VERIFIER_PRIVATE_KEY", hide_env_values = true)]
        signer: Option<String>,
        /// Offline: the serviceId (needed to recompute requestHash).
        #[arg(long)]
        service_id: Option<String>,
        /// Offline: expected hashes to compare against (e.g. from getService / the Held event).
        #[arg(long)]
        request_hash: Option<String>,
        #[arg(long)]
        origin_hash: Option<String>,
        #[arg(long)]
        notary_key_hash: Option<String>,
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// HTTP API for the gateway.
    Serve {
        #[command(flatten)]
        net: Net,
        #[arg(long, default_value = "127.0.0.1:7048")]
        listen: SocketAddr,
        #[arg(long, env = "TEMPO_RPC_URL")]
        rpc: String,
        #[arg(long, env = "FERMATA_ESCROW")]
        escrow: String,
        #[arg(long, env = "VERIFIER_PRIVATE_KEY", hide_env_values = true)]
        signer: String,
        #[arg(long = "predicate", required = true)]
        predicates: Vec<PathBuf>,
        #[arg(long, default_value = "storage/presentations")]
        storage: PathBuf,
    },
    /// Print the registration hashes (originHash, notaryKeyHash, predicateHash).
    Hashes {
        #[arg(long)]
        origin: Option<String>,
        /// Notary signing key (hex) or `--notary-public-key`.
        #[arg(long, env = "NOTARY_PRIVATE_KEY", hide_env_values = true)]
        notary_key: Option<String>,
        #[arg(long)]
        notary_public_key: Option<String>,
        #[arg(long)]
        predicate: Option<PathBuf>,
    },
}

#[derive(Args)]
struct Net {
    #[arg(long, default_value = "127.0.0.1:7047")]
    notary: String,
    /// PEM with the vendor CA(s) (repeatable).
    #[arg(long)]
    ca: Vec<PathBuf>,
    /// `mozilla`: also trust Mozilla's root program (real vendors such as registry.npmjs.org).
    #[arg(long, value_parser = ["mozilla"])]
    roots: Option<String>,
    /// Reach vendors through this HTTP CONNECT proxy, e.g. http://127.0.0.1:3128. Hosts pinned
    /// with --resolve are always dialled directly; the notary never goes through the proxy.
    #[arg(long, env = "FERMATA_UPSTREAM_PROXY")]
    upstream_proxy: Option<String>,
    /// `host:port=ip:port`, like curl --resolve (repeatable).
    #[arg(long)]
    resolve: Vec<String>,
    #[arg(long, default_value_t = 3)]
    attempts: u32,
    /// A healthy MPC session takes 1–2 s here; a stalled one never finishes.
    #[arg(long, default_value_t = 15)]
    attempt_timeout_secs: u64,
    #[arg(long, default_value_t = 4096)]
    max_sent: usize,
    #[arg(long, default_value_t = 16384)]
    max_recv: usize,
}

impl Net {
    fn resolve_map(&self) -> Result<HashMap<String, String>> {
        self.resolve
            .iter()
            .map(|r| {
                r.split_once('=')
                    .map(|(a, b)| (a.to_string(), b.to_string()))
                    .context("--resolve must be host:port=ip:port")
            })
            .collect()
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tlsn=warn,mpz=warn,tlsn_mpc_tls=warn".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    match Cli::parse().cmd {
        Cmd::Notary {
            listen,
            ca,
            roots,
            key,
            timeout_secs,
        } => {
            let key = parse_hex32(&key)?;
            let public = notary::public_key(&key)?;
            println!(
                "{}",
                json!({ "notaryKey": hex0x(&public), "notaryKeyHash": hex0x(&notary_key_hash(&public)), "listen": listen })
            );
            let listener = TcpListener::bind(&listen).await?;
            notary::run(
                listener,
                trust_roots(&ca, roots.is_some())?,
                key,
                Duration::from_secs(timeout_secs),
            )
            .await
        }
        Cmd::Prove {
            net,
            url,
            method,
            headers,
            body,
            call_id,
            out,
        } => {
            let (origin, target) = split_url(&url)?;
            let authority = format!("{}:{}", origin.host, origin.port);
            let body = match body.strip_prefix('@') {
                Some(path) => std::fs::read(path).with_context(|| format!("reading {path}"))?,
                None => body.into_bytes(),
            };
            let headers = headers
                .iter()
                .map(|h| {
                    h.split_once(':')
                        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
                        .context("header must be `name: value`")
                })
                .collect::<Result<Vec<_>>>()?;
            // A host pinned with --resolve is dialled directly; anything else may use the proxy.
            let pinned = net.resolve_map()?.remove(&authority);
            let proxy = match (&pinned, &net.upstream_proxy) {
                (None, Some(url)) => Some(Proxy::parse(url)?),
                _ => None,
            };
            let request = ProveRequest {
                notary: net.notary.clone(),
                connect: pinned.unwrap_or(authority),
                origin,
                roots: trust_roots(&net.ca, net.roots.is_some())?,
                proxy,
                method,
                target,
                headers,
                body,
                call_id: parse_hex32(&call_id)?,
                max_sent: net.max_sent,
                max_recv: net.max_recv,
                redact: prove::default_redactions(),
                setup_timeout: Duration::from_secs(net.attempt_timeout_secs) / 3,
            };
            let result = prove::prove(
                &request,
                net.attempts,
                Duration::from_secs(net.attempt_timeout_secs),
            )
            .await?;
            std::fs::write(&out, &result.presentation)?;
            let mut v = serde_json::to_value(&result)?;
            v["out"] = json!(out);
            v["presentationHash"] = json!(hex0x(&eip712::keccak(&result.presentation)));
            println!("{}", serde_json::to_string_pretty(&v)?);
            Ok(())
        }
        Cmd::Verify {
            presentation,
            ca,
            roots: mozilla,
            call_id,
            predicates,
            offline,
            rpc,
            escrow,
            signer,
            service_id,
            request_hash: expected_rh,
            origin_hash,
            notary_key_hash: expected_nk,
            out,
        } => {
            let bytes = std::fs::read(&presentation)?;
            let roots = trust_roots(&ca, mozilla.is_some())?;
            let call_id = parse_hex32(&call_id)?;
            let store = PredicateStore::load(&predicates)?;
            let result = if offline {
                offline_check(
                    &bytes,
                    &roots,
                    call_id,
                    &predicates,
                    service_id,
                    expected_rh,
                    origin_hash,
                    expected_nk,
                )?
            } else {
                let rpc = rpc.context("--rpc (or TEMPO_RPC_URL) is required unless --offline")?;
                let escrow = parse_hex20(
                    &escrow.context("--escrow (or FERMATA_ESCROW) is required unless --offline")?,
                )?;
                let key =
                    parse_hex32(&signer.context(
                        "--signer (or VERIFIER_PRIVATE_KEY) is required unless --offline",
                    )?)?;
                let chain = RpcChain::connect(&rpc, escrow).await?;
                let domain = Domain {
                    chain_id: chain.chain_id,
                    verifying_contract: escrow,
                };
                let signed = verify::attest(
                    &bytes,
                    call_id,
                    &roots,
                    &chain,
                    |h| store.get(h),
                    &domain,
                    &key,
                    now(),
                )
                .await?;
                json!({ "presentationHash": hex0x(&eip712::keccak(&bytes)), "verdict": signed })
            };
            let text = serde_json::to_string_pretty(&result)?;
            if let Some(out) = out {
                std::fs::write(out, &text)?;
            }
            println!("{text}");
            Ok(())
        }
        Cmd::Serve {
            net,
            listen,
            rpc,
            escrow,
            signer,
            predicates,
            storage,
        } => {
            let chain = RpcChain::connect(&rpc, parse_hex20(&escrow)?).await?;
            let predicates = PredicateStore::load(&predicates)?;
            ensure!(!predicates.is_empty(), "no predicates loaded");
            let state = State {
                chain,
                roots: trust_roots(&net.ca, net.roots.is_some())?,
                ca_paths: net.ca.clone(),
                mozilla_roots: net.roots.is_some(),
                upstream_proxy: net.upstream_proxy.clone(),
                notary: net.notary.clone(),
                predicates,
                key: parse_hex32(&signer)?,
                storage,
                resolve: net.resolve_map()?,
                attempts: net.attempts,
                attempt_timeout: Duration::from_secs(net.attempt_timeout_secs),
                max_sent: net.max_sent,
                max_recv: net.max_recv,
                prove_lock: Default::default(),
            };
            serve::run(listen, state).await
        }
        Cmd::Hashes {
            origin,
            notary_key,
            notary_public_key,
            predicate,
        } => {
            let mut out = serde_json::Map::new();
            if let Some(o) = origin {
                let o = Origin::parse(&o)?;
                out.insert("origin".into(), json!(o.canonical()));
                out.insert("originHash".into(), json!(hex0x(&o.hash())));
            }
            let public = match (notary_public_key, notary_key) {
                (Some(p), _) => Some(hex::decode(p.trim_start_matches("0x"))?),
                (None, Some(k)) => Some(notary::public_key(&parse_hex32(&k)?)?),
                _ => None,
            };
            if let Some(p) = public {
                out.insert("notaryKey".into(), json!(hex0x(&p)));
                out.insert("notaryKeyHash".into(), json!(hex0x(&notary_key_hash(&p))));
            }
            if let Some(p) = predicate {
                let bytes = std::fs::read(&p)?;
                serde_json::from_slice::<Predicate>(&bytes).context("predicate does not parse")?;
                out.insert(
                    "predicateHash".into(),
                    json!(hex0x(&predicate_hash(&bytes))),
                );
            }
            println!("{}", serde_json::to_string_pretty(&out)?);
            Ok(())
        }
    }
}

/// `verify --offline`: what a third party runs on a downloaded presentation. No chain, no key.
#[allow(clippy::too_many_arguments)]
fn offline_check(
    bytes: &[u8],
    roots: &[tlsn::webpki::CertificateDer],
    call_id: [u8; 32],
    predicates: &[PathBuf],
    service_id: Option<String>,
    expected_rh: Option<String>,
    expected_origin: Option<String>,
    expected_nk: Option<String>,
) -> Result<serde_json::Value> {
    ensure!(
        predicates.len() == 1 && predicates[0].is_file(),
        "--offline takes exactly one --predicate file"
    );
    let predicate_bytes = std::fs::read(&predicates[0])?;
    let service_id = service_id.map(|s| parse_hex32(&s)).transpose()?;
    let mut result = verify::reverify(bytes, roots, call_id, service_id, Some(&predicate_bytes))?;
    let mut mismatches = Vec::new();
    for (name, expected) in [
        ("notaryKeyHash", &expected_nk),
        ("originHash", &expected_origin),
        ("requestHash", &expected_rh),
    ] {
        if let Some(e) = expected {
            let actual = result[name].as_str().unwrap_or_default().to_string();
            if parse_hex32(e)? != parse_hex32(&actual).unwrap_or_default() {
                mismatches.push(format!("{name}: expected {e}, presentation gives {actual}"));
            }
        }
    }
    if !result["callHeaderMatches"].as_bool().unwrap_or(false) {
        mismatches.push(format!(
            "X-Fermata-Call {} is not callId {}",
            result["callHeader"],
            hex0x(&call_id)
        ));
    }
    result["offline"] = json!(true);
    result["ok"] = json!(mismatches.is_empty());
    result["mismatches"] = json!(mismatches);
    if !mismatches.is_empty() {
        eprintln!("{}", serde_json::to_string_pretty(&result)?);
        bail!("offline verification found mismatches");
    }
    Ok(result)
}
