//! `prove`: MPC-TLS (or proxy-TLS) prover against a TLS 1.2 server through a TCP notary,
//! producing a presentation that reveals the whole request and the whole response.
//!
//! Ported from WebProof `notarize.rs`/`present.rs` (Apache-2.0) and the upstream
//! `attestation` example at tlsn v0.1.0-alpha.15. Fermata-specific changes: arbitrary method
//! and body, `X-Fermata-Call` header, raw whole-transcript commitments (so malformed responses
//! are still attestable), no `status == 200` assertion, SECP256K1ETH attestation signatures.

use std::{future::IntoFuture, time::Instant};

use anyhow::{Context, Result, anyhow};
use clap::{Parser, ValueEnum};
use futures::io::{AsyncReadExt as _, AsyncWriteExt as _};
use http_body_util::{BodyExt, Full};
use hyper::{Request, body::Bytes};
use hyper_util::rt::TokioIo;
use tokio::net::TcpStream;
use tokio_util::compat::{FuturesAsyncReadCompatExt, TokioAsyncReadCompatExt};
use tracing::{info, warn};

use tlsn::{
    Session,
    attestation::{
        Attestation, CryptoProvider,
        presentation::Presentation,
        request::{Request as AttestationRequest, RequestConfig},
        signing::SignatureAlgId,
    },
    config::{
        prove::ProveConfig, prover::ProverConfig, tls::TlsClientConfig,
        tls_commit::{mpc::MpcTlsConfig, proxy::ProxyTlsConfig},
    },
    connection::{DnsName, HandshakeData, ServerName},
    prover::ProverOutput,
    transcript::TranscriptCommitConfig,
    webpki::{CertificateDer, RootCertStore},
};
use tlsn_formats::http::{DefaultHttpCommitter, HttpCommit, HttpTranscript};

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Mode {
    Mpc,
    Proxy,
}

#[derive(Parser, Debug)]
struct Args {
    #[arg(long, default_value = "127.0.0.1:7047")]
    notary: String,
    /// TCP address of the vendor (MPC mode; in proxy mode the notary dials it).
    #[arg(long, default_value = "127.0.0.1:8443")]
    server: String,
    #[arg(long, default_value = "vendor.fermata.test")]
    server_name: String,
    /// Host header value (defaults to server-name[:port]).
    #[arg(long)]
    host_header: Option<String>,
    #[arg(long)]
    ca: String,
    #[arg(long, default_value = "POST")]
    method: String,
    #[arg(long, default_value = "/v1/quote")]
    path: String,
    #[arg(long, default_value = "")]
    body: String,
    #[arg(long)]
    call_id: String,
    #[arg(long, default_value = "presentation.tlsn")]
    out: String,
    #[arg(long, value_enum, default_value_t = Mode::Mpc)]
    mode: Mode,
    #[arg(long, default_value_t = 4096)]
    max_sent: usize,
    #[arg(long, default_value_t = 16384)]
    max_recv: usize,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let args = Args::parse();
    let t0 = Instant::now();
    let call_id = spike_attest::parse_hex32(&args.call_id)?;
    let ca_pem = std::fs::read(&args.ca).with_context(|| format!("reading {}", args.ca))?;
    let ca = CertificateDer::from_pem_slice(&ca_pem).map_err(|_| anyhow!("CA PEM"))?;
    let host_header = args.host_header.clone().unwrap_or_else(|| {
        let port = args.server.rsplit(':').next().unwrap_or("443");
        if port == "443" { args.server_name.clone() } else { format!("{}:{}", args.server_name, port) }
    });

    // Session with the notary over TCP.
    let notary_socket = TcpStream::connect(&args.notary).await.context("connecting to notary")?;
    notary_socket.set_nodelay(true)?;
    let session = Session::new(notary_socket.compat());
    let (driver, mut handle) = session.split();
    let driver_task = tokio::spawn(driver);

    let tls_config = TlsClientConfig::builder()
        .server_name(ServerName::Dns(args.server_name.as_str().try_into()?))
        .root_store(RootCertStore { roots: vec![ca] })
        .build()?;

    let t_setup = Instant::now();
    let (tls_connection, prover_task) = match args.mode {
        Mode::Mpc => {
            let prover = handle
                .new_prover(ProverConfig::builder().build()?)?
                .commit(
                    MpcTlsConfig::builder()
                        .max_sent_data(args.max_sent)
                        .max_recv_data(args.max_recv)
                        .build()?,
                )
                .await?;
            info!("MPC preprocessing done in {:?}", t_setup.elapsed());
            let server_socket = TcpStream::connect(&args.server).await.context("connecting to vendor")?;
            server_socket.set_nodelay(true)?;
            let (conn, prover) = prover.connect(tls_config, server_socket.compat())?;
            (conn, tokio::spawn(prover.into_future()))
        }
        Mode::Proxy => {
            let prover = handle
                .new_prover(ProverConfig::builder().build()?)?
                .commit(
                    ProxyTlsConfig::builder()
                        .server_name(DnsName::try_from(args.server_name.as_str())?)
                        .build()?,
                )
                .await?;
            let (conn, prover) = prover.connect(tls_config)?;
            (conn, tokio::spawn(prover.into_future()))
        }
    };
    let tls_connection = TokioIo::new(tls_connection.compat());

    let (mut request_sender, connection) = hyper::client::conn::http1::handshake(tls_connection).await?;
    tokio::spawn(connection);

    let request = Request::builder()
        .method(args.method.as_str())
        .uri(&args.path)
        .header("host", &host_header)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .header("accept-encoding", "identity")
        .header("connection", "close")
        .header("x-fermata-call", spike_attest::hex0x(&call_id))
        .body(Full::new(Bytes::from(args.body.clone())))?;

    let t_req = Instant::now();
    let response = request_sender.send_request(request).await?;
    let status = response.status();
    info!("vendor answered {status}");
    // Drain the body; a read error (e.g. server cut the connection) is logged, not fatal:
    // whatever bytes arrived are in the transcript.
    match response.into_body().collect().await {
        Ok(collected) => info!("response body {} bytes", collected.to_bytes().len()),
        Err(e) => warn!("response body read error: {e}"),
    }

    let mut prover = prover_task.await??;
    info!("TLS session closed after {:?} (request phase {:?})", t_setup.elapsed(), t_req.elapsed());

    let len_sent = prover.transcript().sent().len();
    let len_recv = prover.transcript().received().len();

    // Commitments: always the raw whole ranges (so any response, even malformed, can be
    // revealed); additionally the HTTP-structured commitments when the transcript parses.
    let mut builder = TranscriptCommitConfig::builder(prover.transcript());
    builder.commit_sent(0..len_sent)?;
    builder.commit_recv(0..len_recv)?;
    match HttpTranscript::parse(prover.transcript()) {
        Ok(transcript) => {
            DefaultHttpCommitter::default().commit_transcript(&mut builder, &transcript)?;
            info!("HTTP transcript parsed; structured commitments added");
        }
        Err(e) => warn!("HTTP transcript did not parse ({e}); raw commitments only"),
    }
    let transcript_commit = builder.build()?;

    let mut builder = RequestConfig::builder();
    builder.signature_alg(SignatureAlgId::SECP256K1ETH);
    builder.transcript_commit(transcript_commit);
    let request_config = builder.build()?;

    let mut builder = ProveConfig::builder(prover.transcript());
    if let Some(config) = request_config.transcript_commit() {
        builder.transcript_commit(config.clone());
    }
    let disclosure_config = builder.build()?;

    let t_prove = Instant::now();
    let ProverOutput { transcript_commitments, transcript_secrets, .. } =
        prover.prove(&disclosure_config).await?;
    info!("prove phase {:?}", t_prove.elapsed());

    let prover_transcript = prover.transcript().clone();
    let tls_transcript = prover.tls_transcript().clone();
    prover.close().await?;

    let mut builder = AttestationRequest::builder(&request_config);
    builder
        .server_name(ServerName::Dns(args.server_name.as_str().try_into()?))
        .handshake_data(HandshakeData {
            certs: tls_transcript.server_cert_chain().context("server cert chain")?.to_vec(),
            sig: tls_transcript.server_signature().context("server signature")?.clone(),
            binding: tls_transcript.certificate_binding().clone(),
        })
        .transcript(prover_transcript)
        .transcript_commitments(transcript_secrets, transcript_commitments);
    let (request, secrets) = builder.build(&CryptoProvider::default())?;

    // Reclaim the socket and exchange the attestation request/response with the notary.
    handle.close();
    let mut socket = driver_task.await??;
    let t_att = Instant::now();
    socket.write_all(&bincode::serialize(&request)?).await?;
    socket.close().await?;
    let mut attestation_bytes = Vec::new();
    socket.read_to_end(&mut attestation_bytes).await?;
    let attestation: Attestation = bincode::deserialize(&attestation_bytes)?;
    request.validate(&attestation, &CryptoProvider::default())?;
    info!("attestation received in {:?}", t_att.elapsed());

    // Presentation: reveal everything.
    let mut builder = secrets.transcript_proof_builder();
    builder.reveal_sent(0..len_sent)?;
    builder.reveal_recv(0..len_recv)?;
    let transcript_proof = builder.build()?;
    let provider = CryptoProvider::default();
    let mut builder = attestation.presentation_builder(&provider);
    builder.identity_proof(secrets.identity_proof()).transcript_proof(transcript_proof);
    let presentation: Presentation = builder.build()?;
    let bytes = bincode::serialize(&presentation)?;
    std::fs::write(&args.out, &bytes)?;

    let key = attestation.body.verifying_key();
    println!(
        "{}",
        serde_json::json!({
            "out": args.out,
            "mode": format!("{:?}", args.mode).to_lowercase(),
            "status": status.as_u16(),
            "lenSent": len_sent,
            "lenReceived": len_recv,
            "presentationBytes": bytes.len(),
            "notaryKey": spike_attest::hex0x(&key.data),
            "notaryKeyAlg": format!("{}", key.alg),
            "totalMs": t0.elapsed().as_millis(),
        })
    );
    Ok(())
}
