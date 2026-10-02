//! Integration test: real MPC-TLS proofs against the demo vendor (`apps/vendor`, Node, TLS 1.2)
//! through an in-process notary, verified against a mock chain; one negative case per binding
//! check. Exports the acceptance fixture for `contracts/test/AttestVector.t.sol`.
//!
//!   cargo test --release -- --ignored --nocapture      (needs node and openssl on PATH)

use std::{
    net::TcpListener as StdListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};

use fermata_attest::{
    chain::{ChainView, HoldInfo, MockChain, STATUS_HELD, ServiceInfo},
    config::load_roots,
    eip712::{self, Domain, OUTCOME_DELIVERED, OUTCOME_FAILED},
    hashes::{Origin, hex0x, notary_key_hash, predicate_hash, request_hash},
    notary,
    prove::{self, ProveRequest, default_redactions},
    verify::{self, Check, Expected, SignedVerdict, VerifyError},
};
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use serde_json::json;
use tlsn::webpki::CertificateDer;

const NOTARY_KEY: [u8; 32] = [0x22; 32];
const OTHER_NOTARY_KEY: [u8; 32] = [0x33; 32];
const VERIFIER_KEY: [u8; 32] = [0x0b; 32];
/// Fixture escrow address: `AttestVector.t.sol` deploys `FermataEscrow` here with `deployCodeTo`.
const ESCROW: [u8; 20] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xfe, 0x1a,
];
const CHAIN_ID: u64 = 42431;
const TARGET: &str = "/v1/quote?symbol=BTC-USD";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

struct Proc(Child);
impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}

fn free_port() -> u16 {
    StdListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn wait_port(port: u16) {
    for _ in 0..100 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("nothing listening on {port}");
}

async fn vendor(chaos: &str) -> (Proc, u16) {
    let port = free_port();
    let child = Command::new("node")
        .arg(root().join("apps/vendor/server.mjs"))
        .env("PORT", port.to_string())
        .env("CHAOS", chaos)
        .stdout(Stdio::null())
        .spawn()
        .expect("node on PATH");
    wait_port(port).await;
    (Proc(child), port)
}

/// The notary runs as its own process, as in production: prover and notary MPC in one tokio
/// runtime starve each other and a session can stall (seen here; never with two processes).
async fn spawn_notary(key: [u8; 32], ca: &Path) -> (Proc, String) {
    let port = free_port();
    let child = Command::new(env!("CARGO_BIN_EXE_fermata-attest"))
        .args(["notary", "--listen", &format!("127.0.0.1:{port}"), "--ca"])
        .arg(ca)
        .env("NOTARY_PRIVATE_KEY", hex0x(&key))
        .env("RUST_LOG", "error")
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    wait_port(port).await;
    (Proc(child), format!("127.0.0.1:{port}"))
}

fn origin(port: u16) -> Origin {
    Origin::new("vendor.fermata.test", port).unwrap()
}

fn request(
    notary: &str,
    port: u16,
    roots: &[CertificateDer],
    call_id: [u8; 32],
    redact: Vec<String>,
) -> ProveRequest {
    ProveRequest {
        notary: notary.to_string(),
        connect: format!("127.0.0.1:{port}"),
        origin: origin(port),
        roots: roots.to_vec(),
        method: "GET".into(),
        target: TARGET.into(),
        headers: vec![
            ("authorization".into(), "Bearer sk_live_do_not_leak".into()),
            ("accept".into(), "application/json".into()),
        ],
        body: vec![],
        call_id,
        max_sent: 4096,
        max_recv: 16384,
        redact,
        setup_timeout: Duration::from_secs(5),
        proxy: None,
    }
}

async fn prove_ok(req: &ProveRequest) -> Vec<u8> {
    let out = prove::prove(req, 3, Duration::from_secs(15))
        .await
        .expect("prove");
    println!(
        "proved {} in {} ms ({} attempt(s)), MPC traffic {} B sent / {} B received",
        req.connect, out.prove_ms, out.attempts, out.notary_bytes.sent, out.notary_bytes.received
    );
    assert!(
        out.notary_bytes.sent > 100_000 && out.notary_bytes.received > 100_000,
        "MPC traffic not counted"
    );
    out.presentation
}

/// A service registered by `vendor` (serviceId = vendor address ‖ label) and an open hold for `call_id`.
fn register(
    chain_services: &mut Vec<(ServiceInfo, [u8; 32])>,
    label: u8,
    port: u16,
    predicate: &[u8],
) -> ([u8; 32], ServiceInfo) {
    let mut sid = [0u8; 32];
    sid[..20].copy_from_slice(&[0xbe; 20]);
    sid[31] = label;
    let svc = ServiceInfo {
        owner: [0xbe; 20],
        settlement_window: 120,
        payout: [0xbe; 20],
        token: [0x20; 20],
        verifier: eip712::signer_address(&VERIFIER_KEY).unwrap(),
        price_per_call: {
            let mut p = [0u8; 32];
            p[30..].copy_from_slice(&10_000u16.to_be_bytes());
            p
        },
        predicate_hash: predicate_hash(predicate),
        origin_hash: origin(port).hash(),
        notary_key_hash: notary_key_hash(&notary::public_key(&NOTARY_KEY).unwrap()),
    };
    chain_services.push((svc.clone(), sid));
    (sid, svc)
}

fn hold_for(sid: [u8; 32], now: u64) -> HoldInfo {
    HoldInfo {
        agent: [0xa9; 20],
        service_id: sid,
        request_hash: request_hash(&sid, "GET", TARGET, b""),
        amount: [0u8; 32],
        held_at: now - 5,
        deadline: now + 300,
        fee_bps: 50,
        status: STATUS_HELD,
    }
}

fn check_of(e: anyhow::Error) -> Check {
    e.downcast_ref::<VerifyError>()
        .unwrap_or_else(|| panic!("not a VerifyError: {e:#}"))
        .check
}

fn recover(signed: &SignedVerdict, domain: &Domain) -> [u8; 20] {
    let digest = eip712::digest(domain, &signed.verdict);
    let sig = Signature::from_scalars(signed.signature.r, signed.signature.s).unwrap();
    let vk = VerifyingKey::recover_from_prehash(
        &digest,
        &sig,
        RecoveryId::from_byte(signed.signature.v - 27).unwrap(),
    )
    .unwrap();
    let pk = vk.to_encoded_point(false);
    eip712::keccak(&pk.as_bytes()[1..])[12..]
        .try_into()
        .unwrap()
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn gen_other_ca(dir: &Path) -> PathBuf {
    let key = dir.join("other-ca-key.pem");
    let cert = dir.join("other-ca.pem");
    let ok = Command::new("sh")
        .arg("-c")
        .arg(format!(
            "openssl ecparam -name prime256v1 -genkey -noout -out {k} && openssl req -x509 -new -key {k} -sha256 -days 2 -subj /CN=Other -out {c}",
            k = key.display(),
            c = cert.display()
        ))
        .status()
        .unwrap()
        .success();
    assert!(ok, "openssl");
    cert
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs node + openssl; run with --ignored"]
async fn attestor_end_to_end() {
    let vendor_dir = root().join("apps/vendor");
    if !vendor_dir.join("certs/ca.pem").exists() {
        assert!(
            Command::new("bash")
                .arg(vendor_dir.join("gen-certs.sh"))
                .status()
                .unwrap()
                .success()
        );
    }
    let roots = load_roots(&vendor_dir.join("certs/ca.pem")).unwrap();
    let predicate = std::fs::read(root().join("apps/attestor/predicates/quote-v1.json")).unwrap();
    let domain = Domain {
        chain_id: CHAIN_ID,
        verifying_contract: ESCROW,
    };

    let (_ok, ok_port) = vendor("").await;
    let (_e500, port_500) = vendor("500").await;
    let (_trunc, port_trunc) = vendor("truncate").await;
    let (_hang, port_hang) = vendor("hang").await;
    let ca = vendor_dir.join("certs/ca.pem");
    let (_notary, notary_addr) = spawn_notary(NOTARY_KEY, &ca).await;
    let (_other, other_notary) = spawn_notary(OTHER_NOTARY_KEY, &ca).await;

    let mut services = Vec::new();
    let (sid_ok, svc_ok) = register(&mut services, 1, ok_port, &predicate);
    let (sid_500, _) = register(&mut services, 2, port_500, &predicate);
    let (sid_trunc, _) = register(&mut services, 3, port_trunc, &predicate);

    // Holds exist before the calls are proved, as in production (check 7 compares the TLS session
    // time with the hold window).
    let t = now();
    let call_ok = [0xc1; 32];
    let call_500 = [0xc2; 32];
    let call_trunc = [0xc3; 32];
    let t0 = std::time::Instant::now();
    let p_ok = prove_ok(&request(
        &notary_addr,
        ok_port,
        &roots,
        call_ok,
        default_redactions(),
    ))
    .await;
    let ok_ms = t0.elapsed().as_millis();
    assert!(
        ok_ms < 10_000,
        "first prove took {ok_ms} ms (stalled session?)"
    );
    let p_500 = prove_ok(&request(
        &notary_addr,
        port_500,
        &roots,
        call_500,
        default_redactions(),
    ))
    .await;
    let p_trunc = prove_ok(&request(
        &notary_addr,
        port_trunc,
        &roots,
        call_trunc,
        default_redactions(),
    ))
    .await;
    let p_other_notary = prove_ok(&request(
        &other_notary,
        ok_port,
        &roots,
        call_ok,
        default_redactions(),
    ))
    .await;
    let mut bad_redact = default_redactions();
    bad_redact.push("x-fermata-call".into());
    let p_bad_redact = prove_ok(&request(&notary_addr, ok_port, &roots, call_ok, bad_redact)).await;
    println!(
        "proved 5 sessions (first {ok_ms} ms, presentation {} bytes)",
        p_ok.len()
    );

    let chain = MockChain::default();
    for (svc, sid) in &services {
        chain.services.lock().await.insert(*sid, svc.clone());
    }
    for (call, sid) in [
        (call_ok, sid_ok),
        (call_500, sid_500),
        (call_trunc, sid_trunc),
    ] {
        chain.holds.lock().await.insert(call, hold_for(sid, t));
    }
    *chain.now.lock().await = t;
    let predicates = |h: &[u8; 32]| (*h == predicate_hash(&predicate)).then(|| predicate.clone());
    let attest = |bytes: Vec<u8>, call: [u8; 32]| {
        let chain = &chain;
        let domain = &domain;
        let roots = &roots;
        async move {
            verify::attest(
                &bytes,
                call,
                roots,
                chain,
                predicates,
                domain,
                &VERIFIER_KEY,
                t,
            )
            .await
        }
    };

    // ---------------------------------------------------------------- outcomes
    let delivered = attest(p_ok.clone(), call_ok)
        .await
        .expect("ok presentation attests");
    assert_eq!(
        delivered.verdict.outcome, OUTCOME_DELIVERED,
        "{:?}",
        delivered.failures
    );
    assert_eq!(
        recover(&delivered, &domain),
        eip712::signer_address(&VERIFIER_KEY).unwrap()
    );
    assert_eq!(
        delivered.verdict.request_hash,
        request_hash(&sid_ok, "GET", TARGET, b"")
    );
    assert_eq!(delivered.verdict.presentation_hash, eip712::keccak(&p_ok));

    // offline re-verification recomputes exactly what the verdict committed to
    let rv = verify::reverify(&p_ok, &roots, call_ok, Some(sid_ok), Some(&predicate)).unwrap();
    assert_eq!(rv["outcome"], "DELIVERED");
    assert_eq!(rv["requestHash"], hex0x(&delivered.verdict.request_hash));
    assert_eq!(
        rv["presentationHash"],
        hex0x(&delivered.verdict.presentation_hash)
    );
    assert_eq!(rv["responseHash"], hex0x(&delivered.verdict.response_hash));
    assert_eq!(rv["originHash"], hex0x(&svc_ok.origin_hash));
    assert_eq!(rv["callHeaderMatches"], true);
    assert!(!rv["request"].as_str().unwrap().contains("sk_live"));

    let failed_500 = attest(p_500, call_500).await.expect("500 attests");
    assert_eq!(failed_500.verdict.outcome, OUTCOME_FAILED);
    assert!(
        failed_500.failures.iter().any(|f| f.contains("status 500")),
        "{:?}",
        failed_500.failures
    );
    let failed_trunc = attest(p_trunc, call_trunc)
        .await
        .expect("truncated attests");
    assert_eq!(failed_trunc.verdict.outcome, OUTCOME_FAILED);
    assert!(
        failed_trunc
            .failures
            .iter()
            .any(|f| f.contains("not valid JSON")),
        "{:?}",
        failed_trunc.failures
    );

    // The secret never appears in the presentation.
    let v = verify::verify_presentation(&p_ok, &roots).unwrap();
    assert!(
        !String::from_utf8_lossy(&v.sent).contains("sk_live"),
        "token leaked"
    );
    assert!(
        !p_ok.windows(7).any(|w| w == b"sk_live"),
        "token bytes in presentation"
    );
    assert_eq!(v.redacted.len(), 1);

    // ---------------------------------------------------------------- negatives: no verdict, right check
    let base = Expected {
        call_id: call_ok,
        hold: hold_for(sid_ok, t),
        service: svc_ok.clone(),
        predicate_bytes: predicate.clone(),
        now: t,
    };
    let expect = |mutate: &dyn Fn(&mut Expected), check: Check| {
        let mut e = base.clone();
        mutate(&mut e);
        let err = verify::check_bindings(&v, &e).expect_err("must fail");
        assert_eq!(err.check, check, "{err}");
    };
    // 1. notary
    expect(&|e| e.service.notary_key_hash = [9; 32], Check::Notary);
    assert_eq!(
        check_of(attest(p_other_notary, call_ok).await.unwrap_err()),
        Check::Notary
    );
    // 2. origin
    expect(
        &|e| e.service.origin_hash = origin(ok_port + 1).hash(),
        Check::Origin,
    );
    let mut wrong_host = v.clone();
    wrong_host.request.headers.retain(|(k, _)| k != "host");
    wrong_host
        .request
        .headers
        .push(("host".into(), "evil.example:443".into()));
    assert_eq!(
        verify::check_bindings(&wrong_host, &base)
            .unwrap_err()
            .check,
        Check::Origin
    );
    let tmp = std::env::temp_dir().join(format!("fermata-attest-test-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let other_roots = load_roots(&gen_other_ca(&tmp)).unwrap();
    assert_eq!(
        verify::verify_presentation(&p_ok, &other_roots)
            .unwrap_err()
            .check,
        Check::Presentation
    );
    // 3. request
    expect(&|e| e.hold.request_hash = [7; 32], Check::Request);
    assert_eq!(
        verify::verify_presentation(&p_bad_redact, &roots)
            .unwrap_err()
            .check,
        Check::Request
    );
    // 4. predicate
    expect(
        &|e| e.predicate_bytes = b"{\"version\":1,\"status\":[200,500]}".to_vec(),
        Check::Predicate,
    );
    // 5. hold
    expect(&|e| e.hold.status = 3, Check::Hold);
    expect(&|e| e.now = e.hold.deadline + 1, Check::Hold);
    chain.holds.lock().await.get_mut(&call_ok).unwrap().status = 2;
    assert_eq!(
        check_of(attest(p_ok.clone(), call_ok).await.unwrap_err()),
        Check::Hold
    );
    chain.holds.lock().await.get_mut(&call_ok).unwrap().status = STATUS_HELD;
    // 6. call: an old proof for an identical request cannot unlock another hold
    let call_new = [0xc9; 32];
    chain
        .holds
        .lock()
        .await
        .insert(call_new, hold_for(sid_ok, t));
    assert_eq!(
        check_of(attest(p_ok.clone(), call_new).await.unwrap_err()),
        Check::Call
    );
    // 7. time
    expect(
        &|e| e.hold.held_at = v.time + verify::SESSION_SKEW_SECS + 1,
        Check::Time,
    );
    expect(
        &|e| {
            e.hold.deadline = v.time - 1;
            e.now = v.time - 2;
        },
        Check::Time,
    );
    // tampering
    let mut tampered = p_ok.clone();
    let mid = tampered.len() / 2;
    tampered[mid] ^= 1;
    assert_eq!(
        check_of(attest(tampered, call_ok).await.unwrap_err()),
        Check::Presentation
    );
    assert_eq!(
        check_of(
            attest(b"not a presentation".to_vec(), call_ok)
                .await
                .unwrap_err()
        ),
        Check::Presentation
    );
    // no transcript: a vendor that never answers yields an error, never a verdict
    let hang = prove::prove(
        &request(
            &notary_addr,
            port_hang,
            &roots,
            [0xcf; 32],
            default_redactions(),
        ),
        1,
        Duration::from_secs(5),
    )
    .await;
    assert!(hang.is_err());
    // the chain view works through the trait object the same way
    assert_eq!(chain.hold(call_ok).await.unwrap().status, STATUS_HELD);

    // ---------------------------------------------------------------- acceptance fixture for Foundry
    let fixture = json!({
        "note": "generated by apps/attestor/tests/attest.rs — real TLSNotary presentations of the demo vendor",
        "chainId": CHAIN_ID,
        "escrow": hex0x(&ESCROW),
        "vendorPrefix": hex0x(&[0xbe; 20]),
        "signer": hex0x(&eip712::signer_address(&VERIFIER_KEY).unwrap()),
        "notaryKeyHash": hex0x(&svc_ok.notary_key_hash),
        "predicateHash": hex0x(&svc_ok.predicate_hash),
        "delivered": { "originHash": hex0x(&svc_ok.origin_hash), "verdict": delivered.verdict, "signature": delivered.signature_bytes },
        "failed": { "originHash": hex0x(&origin(port_500).hash()), "verdict": failed_500.verdict, "signature": failed_500.signature_bytes },
    });
    let out = root().join("contracts/test/fixtures/attest-vector.json");
    std::fs::write(&out, serde_json::to_string_pretty(&fixture).unwrap() + "\n").unwrap();
    println!("wrote {}", out.display());
}

/// Soak: N sequential proofs from one long-lived process (the `serve` situation). Reports how many
/// attempts each needed.   SOAK=20 cargo test --release soak -- --ignored --nocapture
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "soak test; run with --ignored"]
async fn soak() {
    let n: usize = std::env::var("SOAK")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20);
    let vendor_dir = root().join("apps/vendor");
    let ca = vendor_dir.join("certs/ca.pem");
    let roots = load_roots(&ca).unwrap();
    let (_v, port) = vendor("").await;
    let (_n, notary_addr) = spawn_notary(NOTARY_KEY, &ca).await;
    let mut attempts = Vec::new();
    let mut ms = Vec::new();
    for i in 0..n {
        let out = prove::prove(
            &request(
                &notary_addr,
                port,
                &roots,
                [i as u8; 32],
                default_redactions(),
            ),
            3,
            Duration::from_secs(15),
        )
        .await
        .expect("prove");
        attempts.push(out.attempts);
        ms.push(out.prove_ms);
    }
    println!("soak {n}: attempts {attempts:?}\nms {ms:?}");
}

/// A real third-party vendor: registry.npmjs.org, proved through our notary with Mozilla's roots,
/// over the internet (through `FERMATA_UPSTREAM_PROXY` / `HTTPS_PROXY` when set, else directly).
/// Checks a genuine 200 and a genuine 404, and that the proof does not verify against a dev CA.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs internet access to registry.npmjs.org; run with --ignored"]
async fn real_vendor_npm() {
    use fermata_attest::{config::trust_roots, tunnel::Proxy};
    let mozilla = trust_roots(&[], true).unwrap();
    let port = free_port();
    let child = Command::new(env!("CARGO_BIN_EXE_fermata-attest"))
        .args([
            "notary",
            "--listen",
            &format!("127.0.0.1:{port}"),
            "--roots",
            "mozilla",
        ])
        .env("NOTARY_PRIVATE_KEY", hex0x(&NOTARY_KEY))
        .env("RUST_LOG", "error")
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let _notary = Proc(child);
    wait_port(port).await;
    let proxy = std::env::var("FERMATA_UPSTREAM_PROXY")
        .or_else(|_| std::env::var("HTTPS_PROXY"))
        .ok()
        .map(|p| Proxy::parse(&p).unwrap());
    let req = |target: &str| ProveRequest {
        notary: format!("127.0.0.1:{port}"),
        connect: "registry.npmjs.org:443".into(),
        origin: Origin::new("registry.npmjs.org", 443).unwrap(),
        roots: mozilla.clone(),
        method: "GET".into(),
        target: target.into(),
        headers: vec![("accept".into(), "application/json".into())],
        body: vec![],
        call_id: [0x77; 32],
        max_sent: 4096,
        max_recv: 16384,
        redact: default_redactions(),
        setup_timeout: Duration::from_secs(10),
        proxy: proxy.clone(),
    };

    let out = prove::prove(
        &req("/-/package/mppx/dist-tags"),
        3,
        Duration::from_secs(40),
    )
    .await
    .expect("prove npm");
    println!(
        "npm proved in {} ms, MPC {} B",
        out.prove_ms,
        out.notary_bytes.sent + out.notary_bytes.received
    );
    let v = verify::verify_presentation(&out.presentation, &mozilla)
        .expect("verifies with Mozilla roots");
    assert_eq!(v.server_name, "registry.npmjs.org");
    let res = v.response.expect("HTTP response");
    assert_eq!(res.status, 200);
    assert!(String::from_utf8_lossy(&res.body).contains("\"latest\""));

    let dev_ca = load_roots(&root().join("apps/vendor/certs/ca.pem"));
    if let Ok(dev_ca) = dev_ca {
        assert!(
            verify::verify_presentation(&out.presentation, &dev_ca).is_err(),
            "must not verify against a dev CA"
        );
    }

    let missing = prove::prove(
        &req("/-/package/no-such-package-fermata-zz/dist-tags"),
        3,
        Duration::from_secs(40),
    )
    .await
    .expect("prove npm 404");
    let v = verify::verify_presentation(&missing.presentation, &mozilla).unwrap();
    assert_eq!(v.response.expect("HTTP response").status, 404);
}
