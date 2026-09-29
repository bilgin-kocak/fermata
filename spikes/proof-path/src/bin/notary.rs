//! `notary`: a stand-alone TLSNotary notary over TCP (Fermata spike).
//!
//! Wraps the upstream `attestation` example's `notary()` (tlsn v0.1.0-alpha.15,
//! crates/examples/attestation/prove.rs) — the same in-process logic WebProof uses — behind a
//! TcpListener, one session per connection. Signs attestations with SECP256K1ETH.

use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use clap::Parser;
use futures::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::compat::TokioAsyncReadCompatExt;
use tracing::{error, info};

use tlsn::{
    Session,
    attestation::{
        Attestation, AttestationConfig, CryptoProvider, request::Request as AttestationRequest,
    },
    config::verifier::VerifierConfig,
    connection::{CertBinding, ConnectionInfo, TranscriptLength},
    transcript::ContentType,
    verifier::{VerifierCommitStart, VerifierOutput},
    webpki::{CertificateDer, RootCertStore},
};

#[derive(Parser, Debug)]
struct Args {
    #[arg(long, default_value = "127.0.0.1:7047")]
    listen: String,
    /// PEM file with the CA that signed the vendor's certificate.
    #[arg(long)]
    ca: String,
    /// 32-byte hex secp256k1 signing key.
    #[arg(long)]
    key: String,
    /// host:port the notary dials for proxy-mode sessions (optional).
    #[arg(long)]
    proxy_target: Option<String>,
    #[arg(long, default_value_t = 120)]
    timeout_secs: u64,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let args = Args::parse();
    let key = spike_attest::parse_hex32(&args.key)?;
    let ca_pem = std::fs::read(&args.ca).with_context(|| format!("reading {}", args.ca))?;
    let ca = CertificateDer::from_pem_slice(&ca_pem).map_err(|_| anyhow!("CA PEM"))?;

    let sk = k256::ecdsa::SigningKey::from_slice(&key)?;
    let vk = sk.verifying_key().to_sec1_bytes();
    println!("notary verifying key (SECP256K1ETH, compressed SEC1): 0x{}", hex::encode(&vk));

    let listener = TcpListener::bind(&args.listen).await?;
    println!("notary listening on {}", args.listen);
    loop {
        let (socket, peer) = listener.accept().await?;
        socket.set_nodelay(true)?;
        let ca = ca.clone();
        let proxy_target = args.proxy_target.clone();
        let timeout = Duration::from_secs(args.timeout_secs);
        tokio::spawn(async move {
            info!("session from {peer}");
            match tokio::time::timeout(timeout, notary(socket, ca, key, proxy_target)).await {
                Ok(Ok(())) => info!("session {peer}: attestation issued"),
                Ok(Err(e)) => error!("session {peer} failed: {e:#}"),
                Err(_) => error!("session {peer}: timed out"),
            }
        });
    }
}

async fn notary(
    socket: TcpStream,
    ca: CertificateDer,
    key: [u8; 32],
    proxy_target: Option<String>,
) -> Result<()> {
    let session = Session::new(socket.compat());
    let (driver, mut handle) = session.split();
    let driver_task = tokio::spawn(driver);

    let verifier_config = VerifierConfig::builder()
        .root_store(RootCertStore { roots: vec![ca] })
        .build()?;

    let verifier = match handle.new_verifier(verifier_config)?.commit().await? {
        VerifierCommitStart::Mpc(verifier) => verifier.accept().await?.run().await?,
        VerifierCommitStart::Proxy(verifier) => {
            let Some(target) = proxy_target else {
                verifier.reject(Some("proxy mode not enabled on this notary")).await?;
                return Err(anyhow!("proxy mode requested but --proxy-target not set"));
            };
            let server = TcpStream::connect(&target).await?;
            verifier.accept().await?.run(server.compat()).await?
        }
    };

    let (VerifierOutput { transcript_commitments, .. }, verifier) =
        verifier.verify().await?.accept().await?;

    let tls_transcript = verifier.tls_transcript().clone();
    verifier.close().await?;

    let count = |records: &[tlsn::transcript::Record]| -> usize {
        records
            .iter()
            .filter_map(|r| match r.typ {
                ContentType::ApplicationData => Some(r.ciphertext.len()),
                _ => None,
            })
            .sum()
    };
    let sent_len = count(tls_transcript.sent());
    let recv_len = count(tls_transcript.recv());

    handle.close();
    let mut socket = driver_task.await??;

    let mut request_bytes = Vec::new();
    socket.read_to_end(&mut request_bytes).await?;
    let request: AttestationRequest = bincode::deserialize(&request_bytes)?;

    let mut provider = CryptoProvider::default();
    provider.signer.set_secp256k1eth(&key)?;

    let mut att_config_builder = AttestationConfig::builder();
    att_config_builder.supported_signature_algs(Vec::from_iter(provider.signer.supported_algs()));
    let att_config = att_config_builder.build()?;

    let CertBinding::V1_2(binding) = tls_transcript.certificate_binding() else {
        return Err(anyhow!("unsupported cert binding version"));
    };
    let mut builder = Attestation::builder(&att_config).accept_request(request)?;
    builder
        .connection_info(ConnectionInfo {
            time: tls_transcript.time(),
            version: tls_transcript.version(),
            transcript_length: TranscriptLength { sent: sent_len as u32, received: recv_len as u32 },
        })
        .server_ephemeral_key(binding.server_ephemeral_key.clone())
        .transcript_commitments(transcript_commitments);
    let attestation = builder.build(&provider)?;

    socket.write_all(&bincode::serialize(&attestation)?).await?;
    socket.close().await?;
    Ok(())
}
