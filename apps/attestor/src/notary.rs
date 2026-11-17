//! Notary: a stand-alone TLSNotary notary over plain TCP, one MPC session per connection.
//!
//! tlsn v0.1.0-alpha.15 ships no notary server, so this wraps the upstream `attestation`
//! example's `notary()` (the same logic WebProof uses, Apache-2.0) behind a `TcpListener`, as the
//! Milestone S spike did. Attestations are signed with SECP256K1ETH. The notary is blind: it never
//! sees plaintext, only commitments.
//!
//! Access: with a token, a connection must open with one line, `FERMATA-NOTARY/1 <token>\n`, before
//! any MPC work, or it is closed. The token keeps strangers from using (and costing) the notary; it
//! is not what makes a proof trustworthy, which is the notary's signing key. Over plain TCP it can be
//! sniffed, so a notary on the open internet belongs behind a TLS tunnel.

use std::time::Duration;

use anyhow::{Result, anyhow};
use futures::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _};
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

/// The notary's verifying key: compressed SEC1 (33 bytes). `notaryKeyHash` is its keccak256.
pub fn public_key(key: &[u8; 32]) -> Result<Vec<u8>> {
    Ok(k256::ecdsa::SigningKey::from_slice(key)?
        .verifying_key()
        .to_sec1_bytes()
        .to_vec())
}

/// The first line a client sends to a notary that requires a token.
pub const PREAMBLE: &str = "FERMATA-NOTARY/1 ";
const PREAMBLE_MAX: usize = 256;
const PREAMBLE_TIMEOUT: Duration = Duration::from_secs(5);

/// Client side: opens the session with the token line.
pub async fn send_token<S: AsyncWrite + Unpin>(socket: &mut S, token: &str) -> Result<()> {
    socket
        .write_all(format!("{PREAMBLE}{token}\n").as_bytes())
        .await?;
    socket.flush().await?;
    Ok(())
}

/// Notary side: reads the token line (byte by byte, so nothing of the MPC stream behind it is
/// consumed) and compares it in constant time.
pub async fn check_token<S: AsyncRead + Unpin>(socket: &mut S, token: &str) -> Result<()> {
    let line = tokio::time::timeout(PREAMBLE_TIMEOUT, async {
        let mut line = Vec::with_capacity(64);
        loop {
            let b = socket.read_u8().await?;
            if b == b'\n' {
                return Ok::<_, anyhow::Error>(line);
            }
            if line.len() >= PREAMBLE_MAX {
                return Err(anyhow!("access line longer than {PREAMBLE_MAX} bytes"));
            }
            line.push(b);
        }
    })
    .await
    .map_err(|_| anyhow!("no access line within {PREAMBLE_TIMEOUT:?}"))??;
    let expected = format!("{PREAMBLE}{token}");
    if !constant_time_eq(&line, expected.as_bytes()) {
        return Err(anyhow!("wrong access token"));
    }
    Ok(())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Accepts sessions forever. `roots` must include the CA of every vendor it will notarize; with a
/// `token`, a connection that does not open with it is closed before any MPC work.
pub async fn run(
    listener: TcpListener,
    roots: Vec<CertificateDer>,
    key: [u8; 32],
    timeout: Duration,
    token: Option<String>,
) -> Result<()> {
    loop {
        let (mut socket, peer) = listener.accept().await?;
        socket.set_nodelay(true)?;
        let roots = roots.clone();
        let token = token.clone();
        tokio::spawn(async move {
            if let Some(token) = &token
                && let Err(e) = check_token(&mut socket, token).await
            {
                error!("notary connection {peer} refused: {e:#}");
                let _ = socket.shutdown().await;
                return;
            }
            match tokio::time::timeout(timeout, session(socket, roots, key)).await {
                Ok(Ok(())) => info!("notary session {peer}: attestation issued"),
                Ok(Err(e)) => error!("notary session {peer} failed: {e:#}"),
                Err(_) => error!("notary session {peer}: timed out after {timeout:?}"),
            }
        });
    }
}

async fn session(socket: TcpStream, roots: Vec<CertificateDer>, key: [u8; 32]) -> Result<()> {
    let session = Session::new(socket.compat());
    let (driver, mut handle) = session.split();
    let driver_task = tokio::spawn(driver);

    let verifier_config = VerifierConfig::builder()
        .root_store(RootCertStore { roots })
        .build()?;

    let verifier = match handle.new_verifier(verifier_config)?.commit().await? {
        VerifierCommitStart::Mpc(verifier) => verifier.accept().await?.run().await?,
        VerifierCommitStart::Proxy(verifier) => {
            verifier
                .reject(Some("this notary only runs MPC sessions"))
                .await?;
            return Err(anyhow!("proxy-mode session rejected"));
        }
    };

    let (
        VerifierOutput {
            transcript_commitments,
            ..
        },
        verifier,
    ) = verifier.verify().await?.accept().await?;

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
            transcript_length: TranscriptLength {
                sent: sent_len as u32,
                received: recv_len as u32,
            },
        })
        .server_ephemeral_key(binding.server_ephemeral_key.clone())
        .transcript_commitments(transcript_commitments);
    let attestation = builder.build(&provider)?;

    socket.write_all(&bincode::serialize(&attestation)?).await?;
    socket.close().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[tokio::test]
    async fn the_right_token_passes_and_leaves_the_stream_behind_it_untouched() {
        let (mut client, mut server) = duplex(1024);
        send_token(&mut client, "s3cret").await.unwrap();
        client.write_all(b"MPC").await.unwrap();
        check_token(&mut server, "s3cret").await.unwrap();
        let mut rest = [0u8; 3];
        server.read_exact(&mut rest).await.unwrap();
        assert_eq!(&rest, b"MPC");
    }

    #[tokio::test]
    async fn a_wrong_or_missing_token_is_refused() {
        let (mut client, mut server) = duplex(1024);
        send_token(&mut client, "guess").await.unwrap();
        assert!(
            check_token(&mut server, "s3cret")
                .await
                .unwrap_err()
                .to_string()
                .contains("wrong access token")
        );

        let (mut client, mut server) = duplex(1024);
        client
            .write_all(b"\x16\x03\x01 not a preamble\n")
            .await
            .unwrap();
        assert!(check_token(&mut server, "s3cret").await.is_err());
    }

    #[tokio::test]
    async fn an_endless_line_is_refused() {
        let (mut client, mut server) = duplex(4096);
        client.write_all(&[b'a'; 300]).await.unwrap();
        assert!(
            check_token(&mut server, "s3cret")
                .await
                .unwrap_err()
                .to_string()
                .contains("longer than")
        );
    }

    #[test]
    fn constant_time_eq_compares_whole_values() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }
}
