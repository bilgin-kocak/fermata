//! Verifier: presentation → binding checks against the chain → predicate → signed verdict.
//!
//! Fails closed. A verdict is produced only after the presentation verifies cryptographically and
//! every binding check passes (PROMPT.md "Proof-to-purchase binding", checks 1–5, plus two):
//!   1 notary   — keccak256(notary key) == service.notaryKeyHash
//!   2 origin   — TLS server name == Host header host; originHash(https://host[:port]) == service.originHash
//!   3 request  — only auth header values hidden; recomputed requestHash == hold.requestHash
//!   4 predicate — sha256(predicate bytes) == service.predicateHash
//!   5 hold     — status Held, not past its deadline (chain time)
//!   6 call     — revealed `X-Fermata-Call` header == callId (an old proof cannot unlock a new hold)
//!   7 time     — TLS session time within [heldAt − 60 s, deadline]
//! Only then is the predicate evaluated (DELIVERED / FAILED) and the verdict signed.

use std::fmt;

use serde::Serialize;
use tlsn::{
    attestation::{
        CryptoProvider,
        presentation::{Presentation, PresentationOutput},
    },
    connection::ServerName,
    verifier::ServerCertVerifier,
    webpki::{CertificateDer, RootCertStore},
};

use crate::{
    chain::{ChainView, HoldInfo, STATUS_HELD, ServiceInfo},
    eip712::{self, Domain, OUTCOME_DELIVERED, OUTCOME_FAILED, Signature, Verdict},
    hashes::{Origin, hex0x, notary_key_hash, predicate_hash, request_hash},
    http_raw::{self, RawRequest, RawResponse},
    predicate::{self, Predicate},
    prove::REDACTED_HEADERS,
};

/// Allowed skew between the notary's session clock and the chain's `heldAt`.
pub const SESSION_SKEW_SECS: u64 = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Check {
    Presentation,
    Notary,
    Origin,
    Request,
    Predicate,
    Hold,
    Call,
    Time,
}

#[derive(Debug)]
pub struct VerifyError {
    pub check: Check,
    pub detail: String,
}

impl fmt::Display for VerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?} check failed: {}", self.check, self.detail)
    }
}

impl std::error::Error for VerifyError {}

fn fail<T>(check: Check, detail: impl Into<String>) -> Result<T, VerifyError> {
    Err(VerifyError {
        check,
        detail: detail.into(),
    })
}

/// What a presentation proves, after cryptographic verification (no chain involved yet).
#[derive(Clone, Debug)]
pub struct VerifiedCall {
    pub presentation_hash: [u8; 32],
    pub notary_key: Vec<u8>,
    pub server_name: String,
    /// TLS session time (seconds), as attested by the notary.
    pub time: u64,
    /// Sent bytes; hidden bytes are replaced by `*`.
    pub sent: Vec<u8>,
    pub received: Vec<u8>,
    pub request: RawRequest,
    /// `Err` when the response is not parseable HTTP (the predicate then fails).
    pub response: Result<RawResponse, String>,
    /// Hidden byte ranges of the sent transcript.
    pub redacted: Vec<(usize, usize)>,
}

impl VerifiedCall {
    pub fn call_header(&self) -> Option<&str> {
        http_raw::header(&self.request.headers, "x-fermata-call")
    }

    pub fn host_header(&self) -> Option<&str> {
        http_raw::header(&self.request.headers, "host")
    }

    /// The origin this presentation is against: TLS identity + the port from the Host header.
    pub fn origin(&self) -> Result<Origin, VerifyError> {
        let Some(host) = self.host_header() else {
            return fail(Check::Origin, "no Host header");
        };
        let (host_part, port) = match host.rsplit_once(':') {
            Some((h, p)) => match p.parse::<u16>() {
                Ok(p) => (h, p),
                Err(_) => return fail(Check::Origin, format!("bad port in Host {host:?}")),
            },
            None => (host, 443),
        };
        if !host_part.eq_ignore_ascii_case(&self.server_name) {
            return fail(
                Check::Origin,
                format!(
                    "Host {host:?} does not name the TLS server {}",
                    self.server_name
                ),
            );
        }
        Origin::new(&self.server_name, port).or_else(|e| fail(Check::Origin, e.to_string()))
    }
}

/// Step 0: deserialize, verify the notary signature, the server certificate against `roots` (the
/// only trust anchors) and the transcript commitments. Checks the redaction policy.
pub fn verify_presentation(
    bytes: &[u8],
    roots: &[CertificateDer],
) -> Result<VerifiedCall, VerifyError> {
    use Check::Presentation as P;
    let presentation: Presentation =
        bincode::deserialize(bytes).or_else(|e| fail(P, format!("does not deserialize: {e}")))?;
    let notary_key = presentation.verifying_key().data.clone();
    let cert = ServerCertVerifier::new(&RootCertStore {
        roots: roots.to_vec(),
    })
    .or_else(|e| fail(P, e.to_string()))?;
    let provider = CryptoProvider {
        cert,
        ..Default::default()
    };
    let PresentationOutput {
        server_name,
        connection_info,
        transcript,
        ..
    } = presentation
        .verify(&provider)
        .or_else(|e| fail(P, format!("verification failed: {e}")))?;
    let Some(ServerName::Dns(dns)) = server_name else {
        return fail(P, "no server identity");
    };
    let Some(mut transcript) = transcript else {
        return fail(P, "no transcript");
    };

    if !transcript.received_unauthed().is_empty() {
        return fail(Check::Request, "response is not fully revealed");
    }
    let hidden: Vec<(usize, usize)> = transcript
        .sent_unauthed()
        .iter()
        .map(|r| (r.start, r.end))
        .collect();
    transcript.set_unauthed(b'*');
    let sent = transcript.sent_unsafe().to_vec();
    let received = transcript.received_unsafe().to_vec();

    let request = http_raw::parse_request(&sent)
        .or_else(|e| fail(Check::Request, format!("request: {e:#}")))?;
    // Every hidden byte must sit inside the value of an allowed header.
    let allowed = crate::prove::redaction_ranges(&sent, &REDACTED_HEADERS)
        .or_else(|e| fail(Check::Request, format!("{e:#}")))?;
    for (a, b) in &hidden {
        if !allowed.iter().any(|r| r.start <= *a && *b <= r.end) {
            return fail(
                Check::Request,
                format!("bytes {a}..{b} hidden outside the values of {REDACTED_HEADERS:?}"),
            );
        }
    }
    let response = http_raw::parse_response(&received).map_err(|e| format!("{e:#}"));

    Ok(VerifiedCall {
        presentation_hash: eip712::keccak(bytes),
        notary_key,
        server_name: dns.as_str().to_ascii_lowercase(),
        time: connection_info.time,
        sent,
        received,
        request,
        response,
        redacted: hidden,
    })
}

/// Everything the binding checks compare against.
#[derive(Clone, Debug)]
pub struct Expected {
    pub call_id: [u8; 32],
    pub hold: HoldInfo,
    pub service: ServiceInfo,
    pub predicate_bytes: Vec<u8>,
    /// Latest chain timestamp.
    pub now: u64,
}

/// Checks 1–7, in order. Returns the recomputed requestHash.
pub fn check_bindings(v: &VerifiedCall, e: &Expected) -> Result<[u8; 32], VerifyError> {
    // 1. notary
    if notary_key_hash(&v.notary_key) != e.service.notary_key_hash {
        return fail(
            Check::Notary,
            format!(
                "notary key {} is not the service's notary",
                hex0x(&v.notary_key)
            ),
        );
    }
    // 2. origin
    let origin = v.origin()?;
    if origin.hash() != e.service.origin_hash {
        return fail(
            Check::Origin,
            format!("{} is not the registered origin", origin.canonical()),
        );
    }
    // 3. request
    let rh = request_hash(
        &e.hold.service_id,
        &v.request.method,
        &v.request.target,
        &v.request.body,
    );
    if rh != e.hold.request_hash {
        return fail(
            Check::Request,
            format!(
                "{} {} hashes to {}, hold has {}",
                v.request.method,
                v.request.target,
                hex0x(&rh),
                hex0x(&e.hold.request_hash)
            ),
        );
    }
    // 4. predicate
    if predicate_hash(&e.predicate_bytes) != e.service.predicate_hash {
        return fail(
            Check::Predicate,
            "predicate does not hash to the registered predicateHash",
        );
    }
    // 5. hold
    if e.hold.status != STATUS_HELD {
        return fail(
            Check::Hold,
            format!("hold status {} is not Held", e.hold.status),
        );
    }
    if e.now > e.hold.deadline {
        return fail(
            Check::Hold,
            format!(
                "settlement window closed at {} (chain time {})",
                e.hold.deadline, e.now
            ),
        );
    }
    // 6. call
    match v.call_header() {
        Some(h) if h.trim().eq_ignore_ascii_case(&hex0x(&e.call_id)) => {}
        other => {
            return fail(
                Check::Call,
                format!(
                    "X-Fermata-Call {other:?} is not callId {}",
                    hex0x(&e.call_id)
                ),
            );
        }
    }
    // 7. time
    if v.time + SESSION_SKEW_SECS < e.hold.held_at || v.time > e.hold.deadline {
        return fail(
            Check::Time,
            format!(
                "TLS session at {} outside the hold window [{}, {}]",
                v.time, e.hold.held_at, e.hold.deadline
            ),
        );
    }
    Ok(rh)
}

/// Evaluates the delivery predicate on the revealed response. Returns (outcome, failures).
pub fn decide(v: &VerifiedCall, predicate: &Predicate) -> (u8, Vec<String>) {
    let failures = match &v.response {
        Ok(res) => predicate::evaluate(
            predicate,
            res.status,
            http_raw::header(&res.headers, "content-type"),
            &res.body,
        ),
        Err(e) => vec![format!("response is not HTTP: {e}")],
    };
    (
        if failures.is_empty() {
            OUTCOME_DELIVERED
        } else {
            OUTCOME_FAILED
        },
        failures,
    )
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedVerdict {
    pub verdict: Verdict,
    pub outcome: &'static str,
    pub failures: Vec<String>,
    pub digest: String,
    pub signature: Signature,
    /// 65 bytes r ‖ s ‖ v, the form `FermataEscrow.settle` takes.
    pub signature_bytes: String,
    pub signer: String,
}

pub fn outcome_name(outcome: u8) -> &'static str {
    if outcome == OUTCOME_DELIVERED {
        "DELIVERED"
    } else {
        "FAILED"
    }
}

pub fn sign_verdict(
    verdict: Verdict,
    failures: Vec<String>,
    domain: &Domain,
    key: &[u8; 32],
) -> anyhow::Result<SignedVerdict> {
    let digest = eip712::digest(domain, &verdict);
    let signature = eip712::sign(key, &digest)?;
    Ok(SignedVerdict {
        outcome: outcome_name(verdict.outcome),
        verdict,
        failures,
        digest: hex0x(&digest),
        signature_bytes: format!(
            "0x{}{}{:02x}",
            hex::encode(signature.r),
            hex::encode(signature.s),
            signature.v
        ),
        signature,
        signer: hex0x(&eip712::signer_address(key)?),
    })
}

/// The whole online pipeline: chain reads → checks → predicate → signed verdict.
/// `predicate_for` returns the predicate bytes registered under a predicateHash (content-addressed).
#[allow(clippy::too_many_arguments)]
pub async fn attest<C: ChainView>(
    presentation: &[u8],
    call_id: [u8; 32],
    roots: &[CertificateDer],
    chain: &C,
    predicate_for: impl Fn(&[u8; 32]) -> Option<Vec<u8>>,
    domain: &Domain,
    key: &[u8; 32],
    issued_at: u64,
) -> anyhow::Result<SignedVerdict> {
    let v = verify_presentation(presentation, roots)?;
    let hold = chain.hold(call_id).await?;
    if hold.status != STATUS_HELD {
        return Err(VerifyError {
            check: Check::Hold,
            detail: format!("hold status {} is not Held", hold.status),
        }
        .into());
    }
    let service = chain.service(hold.service_id).await?;
    let predicate_bytes = predicate_for(&service.predicate_hash).ok_or_else(|| VerifyError {
        check: Check::Predicate,
        detail: format!(
            "no predicate on file for predicateHash {}",
            hex0x(&service.predicate_hash)
        ),
    })?;
    let now = chain.latest_timestamp().await?;
    let expected = Expected {
        call_id,
        hold,
        service,
        predicate_bytes,
        now,
    };
    let request_hash = check_bindings(&v, &expected)?;
    let predicate: Predicate =
        serde_json::from_slice(&expected.predicate_bytes).map_err(|e| VerifyError {
            check: Check::Predicate,
            detail: format!("predicate JSON: {e}"),
        })?;
    let (outcome, failures) = decide(&v, &predicate);
    let verdict = Verdict {
        call_id,
        service_id: expected.hold.service_id,
        request_hash,
        predicate_hash: expected.service.predicate_hash,
        outcome,
        presentation_hash: v.presentation_hash,
        response_hash: eip712::keccak(&v.received),
        issued_at,
    };
    sign_verdict(verdict, failures, domain, key)
}

/// Offline re-verification (no chain, no key): what a third party recomputes from a downloaded
/// presentation. Every hash the escrow and the verdict commit to is recomputed so the caller can
/// compare it with the on-chain values; the outcome is recomputed when the predicate is supplied.
pub fn reverify(
    presentation: &[u8],
    roots: &[CertificateDer],
    call_id: [u8; 32],
    service_id: Option<[u8; 32]>,
    predicate_bytes: Option<&[u8]>,
) -> Result<serde_json::Value, VerifyError> {
    let v = verify_presentation(presentation, roots)?;
    let origin = v.origin()?;
    let request_hash = service_id.map(|s| {
        hex0x(&request_hash(
            &s,
            &v.request.method,
            &v.request.target,
            &v.request.body,
        ))
    });
    let decided = match predicate_bytes {
        Some(bytes) => {
            let p: Predicate = serde_json::from_slice(bytes).map_err(|e| VerifyError {
                check: Check::Predicate,
                detail: format!("predicate JSON: {e}"),
            })?;
            let (outcome, failures) = decide(&v, &p);
            Some((
                outcome_name(outcome),
                failures,
                hex0x(&predicate_hash(bytes)),
            ))
        }
        None => None,
    };
    let call_header_matches = v
        .call_header()
        .is_some_and(|h| h.trim().eq_ignore_ascii_case(&hex0x(&call_id)));
    Ok(serde_json::json!({
        "presentationHash": hex0x(&v.presentation_hash),
        "responseHash": hex0x(&eip712::keccak(&v.received)),
        "requestHash": request_hash,
        "notaryKey": hex0x(&v.notary_key),
        "notaryKeyHash": hex0x(&notary_key_hash(&v.notary_key)),
        "origin": origin.canonical(),
        "originHash": hex0x(&origin.hash()),
        "callHeader": v.call_header(),
        "callHeaderMatches": call_header_matches,
        "sessionTime": v.time,
        "redactedRanges": v.redacted,
        "outcome": decided.as_ref().map(|d| d.0),
        "failures": decided.as_ref().map(|d| d.1.clone()),
        "predicateHash": decided.as_ref().map(|d| d.2.clone()),
        "request": String::from_utf8_lossy(&v.sent),
        "response": String::from_utf8_lossy(&v.received),
    }))
}
