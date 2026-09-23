//! `verify`: offline verification of a presentation + Fermata binding checks + predicate +
//! EIP-712 verdict signature. `--vector` prints the fixed EIP-712 cross-check vector instead.
//!
//! Ported from WebProof `verify.rs` (Apache-2.0) and the upstream `attestation/verify.rs`.

use anyhow::{Context, Result, anyhow, bail};
use clap::Parser;
use spike_attest::{eip712, http_raw, predicate};
use tlsn::{
    attestation::{
        CryptoProvider,
        presentation::{Presentation, PresentationOutput},
    },
    connection::ServerName,
    verifier::ServerCertVerifier,
    webpki::{CertificateDer, RootCertStore},
};

#[derive(Parser, Debug)]
struct Args {
    /// Print the fixed EIP-712 test vector (JSON) and exit.
    #[arg(long)]
    vector: bool,
    #[arg(long, default_value = "presentation.tlsn")]
    presentation: String,
    #[arg(long)]
    ca: Option<String>,
    /// Pinned notary verifying key (hex, compressed SEC1).
    #[arg(long)]
    notary_key: Option<String>,
    /// Registered origin, e.g. https://vendor.fermata.test:8443
    #[arg(long)]
    origin: Option<String>,
    #[arg(long)]
    predicate: Option<String>,
    #[arg(long)]
    call_id: Option<String>,
    #[arg(long, default_value = "0x0000000000000000000000000000000000000000000000000000000000000001")]
    service_id: String,
    #[arg(long, default_value = "0x0000000000000000000000000000000000000Fe1")]
    escrow: String,
    #[arg(long, default_value_t = 42431)]
    chain_id: u64,
    /// 32-byte hex verifier signing key.
    #[arg(long, default_value = "0x0000000000000000000000000000000000000000000000000000000000000001")]
    signer: String,
    #[arg(long, default_value = "verdict.json")]
    out: String,
}

fn main() -> Result<()> {
    let args = Args::parse();
    if args.vector {
        return print_vector();
    }
    let ca_path = args.ca.as_ref().context("--ca required")?;
    let notary_key = hex::decode(args.notary_key.as_ref().context("--notary-key required")?.trim_start_matches("0x"))?;
    let origin = args.origin.as_ref().context("--origin required")?;
    let predicate_bytes = std::fs::read(args.predicate.as_ref().context("--predicate required")?)?;
    let predicate: predicate::Predicate = serde_json::from_slice(&predicate_bytes)?;
    let call_id = spike_attest::parse_hex32(args.call_id.as_ref().context("--call-id required")?)?;
    let service_id = spike_attest::parse_hex32(&args.service_id)?;
    let escrow = spike_attest::parse_hex20(&args.escrow)?;
    let signer = spike_attest::parse_hex32(&args.signer)?;

    let presentation_bytes = std::fs::read(&args.presentation)?;
    let presentation: Presentation =
        bincode::deserialize(&presentation_bytes).context("presentation does not deserialize")?;

    // 1. Notary key pin (Presentation::verify does not judge key trust).
    let key_data = presentation.verifying_key().data.clone();
    if key_data != notary_key {
        bail!("untrusted notary key: presentation signed by 0x{}", hex::encode(&key_data));
    }

    // 2. Cryptographic verification with the service's CA as the only trust root.
    let ca_pem = std::fs::read(ca_path)?;
    let ca = CertificateDer::from_pem_slice(&ca_pem).map_err(|_| anyhow!("CA PEM"))?;
    let provider = CryptoProvider {
        cert: ServerCertVerifier::new(&RootCertStore { roots: vec![ca] })?,
        ..Default::default()
    };
    let PresentationOutput { server_name, connection_info, transcript, .. } = presentation
        .verify(&provider)
        .map_err(|e| anyhow!("presentation verification failed: {e}"))?;
    let server_name = server_name.context("presentation carries no server identity")?;
    let transcript = transcript.context("presentation carries no transcript")?;
    if !transcript.is_complete() {
        bail!("transcript is not fully revealed");
    }
    let sent = transcript.sent_unsafe().to_vec();
    let received = transcript.received_unsafe().to_vec();

    // 3. Raw HTTP parse (never tlsn-formats: malformed bodies must still verify).
    let req = http_raw::parse_request(&sent)?;
    let res = http_raw::parse_response(&received)?;
    println!("--- request ---\n{} {} HTTP/1.1", req.method, req.target);
    for (k, v) in &req.headers {
        println!("{k}: {v}");
    }
    println!("\n{}", String::from_utf8_lossy(&req.body));
    println!("--- response ---\nHTTP/1.1 {}", res.status);
    for (k, v) in &res.headers {
        println!("{k}: {v}");
    }
    println!("\n{}\n---", String::from_utf8_lossy(&res.body));

    // 4. Origin binding: TLS identity and Host header.
    let url_host = origin
        .trim_start_matches("https://")
        .trim_end_matches('/')
        .to_string();
    let (origin_host, origin_port) = match url_host.split_once(':') {
        Some((h, p)) => (h.to_string(), p.to_string()),
        None => (url_host.clone(), "443".to_string()),
    };
    let ServerName::Dns(dns) = &server_name;
    if !dns.as_str().eq_ignore_ascii_case(&origin_host) {
        bail!("server name {} != origin host {origin_host}", dns.as_str());
    }
    let expected_host = if origin_port == "443" { origin_host.clone() } else { format!("{origin_host}:{origin_port}") };
    match http_raw::header(&req.headers, "host") {
        Some(h) if h.eq_ignore_ascii_case(&expected_host) => {}
        other => bail!("Host header {other:?} != {expected_host:?}"),
    }

    // 5. Call binding: the revealed X-Fermata-Call header must equal the callId.
    match http_raw::header(&req.headers, "x-fermata-call") {
        Some(h) if h.eq_ignore_ascii_case(&spike_attest::hex0x(&call_id)) => {}
        other => bail!("x-fermata-call {other:?} != callId {}", spike_attest::hex0x(&call_id)),
    }

    // 6. requestHash recomputation (compared against the on-chain Held event by the gateway).
    let request_hash = spike_attest::request_hash(&service_id, &req.method, &req.target, &req.body);

    // 7. Predicate → outcome.
    let failures = predicate::evaluate(&predicate, res.status, http_raw::header(&res.headers, "content-type"), &res.body);
    let outcome = if failures.is_empty() { eip712::OUTCOME_DELIVERED } else { eip712::OUTCOME_FAILED };
    for f in &failures {
        println!("predicate: {f}");
    }

    // 8. Verdict + EIP-712 signature.
    let verdict = eip712::Verdict {
        call_id,
        service_id,
        request_hash,
        predicate_hash: spike_attest::sha256(&predicate_bytes),
        outcome,
        presentation_hash: eip712::keccak(&presentation_bytes),
        response_hash: eip712::keccak(&received),
        issued_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs(),
    };
    let domain = eip712::Domain { chain_id: args.chain_id, verifying_contract: escrow };
    let digest = eip712::digest(&domain, &verdict);
    let signature = eip712::sign(&signer, &digest)?;
    let out = serde_json::json!({
        "verdict": verdict,
        "domain": domain,
        "digest": spike_attest::hex0x(&digest),
        "signature": signature,
        "signatureBytes": format!("0x{}{}{:02x}", hex::encode(signature.r), hex::encode(signature.s), signature.v),
        "signer": spike_attest::hex0x(&eip712::signer_address(&signer)?),
        "notaryKey": spike_attest::hex0x(&key_data),
        "requestHash": spike_attest::hex0x(&request_hash),
        "outcome": if outcome == 1 { "DELIVERED" } else { "FAILED" },
        "failures": failures,
        "serverName": dns.as_str(),
        "time": connection_info.time,
        "tlsVersion": format!("{:?}", connection_info.version),
        "lenSent": transcript.len_sent(),
        "lenReceived": transcript.len_received(),
        "presentationBytes": presentation_bytes.len(),
    });
    let json = serde_json::to_string_pretty(&out)?;
    std::fs::write(&args.out, &json)?;
    println!("{json}");
    Ok(())
}

fn print_vector() -> Result<()> {
    let (domain, verdict, key) = eip712::test_vector();
    let digest = eip712::digest(&domain, &verdict);
    let sig = eip712::sign(&key, &digest)?;
    let out = serde_json::json!({
        "domainSeparator": spike_attest::hex0x(&eip712::domain_separator(&domain)),
        "structHash": spike_attest::hex0x(&eip712::struct_hash(&verdict)),
        "digest": spike_attest::hex0x(&digest),
        "typeHash": spike_attest::hex0x(&eip712::keccak(eip712::VERDICT_TYPE.as_bytes())),
        "signer": spike_attest::hex0x(&eip712::signer_address(&key)?),
        "privateKey": spike_attest::hex0x(&key),
        "verdict": verdict,
        "domain": domain,
        "signature": sig,
        "signatureBytes": format!("0x{}{}{:02x}", hex::encode(sig.r), hex::encode(sig.s), sig.v),
    });
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}
