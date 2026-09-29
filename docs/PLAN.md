# PLAN.md — milestones, estimates and design decisions

Status as of **2026-09-29**: Milestones 0, S, 1, 2, 3, 4 and **5 done locally** — escrow contract, and the
Rust attestor proving the demo vendor with TLSNotary, binding the proof to the on-chain hold and
signing verdicts that the escrow settles (live on Anvil's Tempo emulation). Every Moderato step is
**DEFERRED** because `rpc.moderato.tempo.xyz` is refused (HTTP 403) by the build environment's
network policy. 13 days remain to 2026-10-12; freeze on **2026-10-09**.

## Calendar

| Milestone | Prompt estimate | Revised | Planned dates | Why the change |
|---|---|---|---|---|
| 0 Facts and plan | 0.5 d | 1 d (done) | 09-23 | doc hosts blocked → read GitHub sources; built tlsn |
| S Integration spike | 1–1.5 d | done in 1 d (09-23) | 09-23 | all local legs GREEN; Moderato legs deferred (RPC blocked) |
| 1 Escrow contract | 2 d | done in 1 d (09-24) | 09-24 | local GREEN; Moderato deploy deferred (RPC blocked) |
| 2 Attestor | 3–4 d | done in 1 d (09-29) | 09-29 | −1 d from the WebProof port, +0.5 d TCP notary + key handling, +0.5 d binding checks/tests |
| 3 Gateway + method + SDK | 3 d | done in 1 d (09-29) | 09-29 | unchanged; receipt emission mechanism already found |
| 4 Vendor, agent, dashboard | 3 d | done in 1 d (09-29) | 09-29 | unchanged; cut dashboard scope first if slipping |
| 5 Submission polish | 2 d | done in 1 d (09-29) | 09-29 | video edit + Moderato run remain (Bilgin / network) |
| **Total** | 14.5–16 d | **≈ 16 d** | freeze 10-09 | ≈ 1 day of slack |

Largest schedule risk: every on-chain step (spike probes 1 and 3, M1 deploy, M3/M4 end to end,
the validator's payment) needs `rpc.moderato.tempo.xyz`, which the build environment still
blocks. Bilgin is allowing the hosts; until then contract work runs on Anvil with a TIP-20 mock
and on-chain steps are deferred, never faked. Second risk: `mppx@0.11.0` is a day-old release.

## Milestone S results (2026-09-23)

`spikes/gate.sh` → PROBE 1/2/3 GREEN. Facts learned that shape the next milestones:
- **Raw whole-transcript commitments** are mandatory: tlsn's HTTP parser rejects malformed
  bodies, so the prover commits `0..len` of both directions and adds the HTTP-structured
  commitments only when parsing succeeds; the verifier parses raw bytes with `httparse` and the
  predicate decides. A 500 and a truncated-JSON response both produced `FAILED` verdicts.
- **Two-process notary works** over plain TCP (half-close, `read_to_end`); MPC mode ≈ 1.1–1.5 s
  per call on 4 vCPU, proxy mode ≈ 0.5 s. One MPC hang in four runs → the attestor keeps a
  150 s timeout + one retry, and the gateway must serialise proving on small machines.
- **EIP-712**: Rust k256 signature == Foundry `vm.sign` byte for byte; `SpikeSettle.settle`
  accepts it and rejects replay; domain must use the deployed escrow address (verify takes
  `--escrow`/`--chain-id`).
- **mppx**: `requestHash` is computed by the route from the cloned body and passed as the
  `probe` route option in a per-request `compose`; the `request` hook only echoes `callId`;
  receipt overwritten after `withReceipt`; `Store.tryClaim` on callId; plain `Error` → 500.
  Discovery needs handler-style routes (legacy routes don't merge method defaults) plus
  `/llms.txt` and a `requestBody` to satisfy the validator.
- **Anvil emulates Tempo** (chain id 42431): real TIP-20 precompile semantics incl. permit and
  memo events, stablecoin fee deduction (AlphaUSD by default for dev accounts). Milestone 1's
  Foundry tests can target the emulated precompile as well as the mock.
- **TIP-20 hold shape confirmed**: `permit` + `transferFromWithMemo` in one tx, memo = callId
  readable by topic, 567k gas, ≈ $0.006 fee, relayer pays, no fee-token setup needed.

## What changed against the prompt (design deltas forced by FACTS.md)

1. **Notary**: TLSNotary v0.1.0-alpha.15 has no notary server and PSE's is shut down (FACTS
   §12.2). The attestor ships `fermata-attest notary --listen 127.0.0.1:7047`: the upstream
   example's `notary()` function behind a TCP listener (one task per connection, length-prefixed
   framing for the attestation request/response, `TCP_NODELAY`, a cap on prover-proposed
   `max_sent/recv_data`, persistent secp256k1 key from `.env`). Prover and notary are the same
   binary build (tlsn requires identical versions) and run as two processes, which keeps the
   "notary is a separate blind process" trust story. README/pitch drop "pluggable to PSE's
   notary" and say "pluggable to any tlsn alpha.15-compatible notary". Decided with Bilgin.
2. **TLS**: the demo vendor must serve TLS 1.2 with `ECDHE-ECDSA-AES128-GCM-SHA256` (or the RSA
   variant), P-256 key exchange, HTTP/1.1, no compression, a DNS hostname (FACTS §12.4).
3. **mkcert → OpenSSL**: `scripts/gen-certs.sh` creates a local CA (`basicConstraints=CA:TRUE`)
   and a P-256 ECDSA leaf with SAN `DNS:vendor.fermata.test`; the CA root is loaded into the
   prover, the notary and the verifier root stores. Equivalent to mkcert for TLSNotary.
4. **Explorer links** use `https://explore.testnet.tempo.xyz` (FACTS §2).
5. **TIP-20 interface**: `ITIP20.transferWithMemo` is declared without a return value; the event
   parameter is `amount` (FACTS §5). Not a change to Fermata's contract interface.
6. **mppx**: `fermata` is a `Method.from/toServer/toClient` plugin — no fork (FACTS §10). The
   validator will pay only the `tempo` fallback and silently skip `fermata` (FACTS §11); the
   gateway serves `/openapi.json` so the validator can exit 0.
7. **Toolchain**: Rust 1.95.0 for the attestor workspace; Foundry 1.8.3 (first Tempo-aware
   line is 1.7.0); mppx pinned to 0.11.0; viem ≥ 2.54.6.

## Milestone S — integration spike (1.5 d, go/no-go gate)

Throwaway code under `spikes/`, one README line per probe stating what it proved and how long.

**Probe 1 — proof path** (`spikes/proof-path/`, Rust + Node + Foundry)
- `gen-certs.sh` → Node `https` server with the TLS 1.2 config from FACTS §12.4, serving
  `/v1/quote` JSON; preflight with `openssl s_client -tls1_2 -cipher ECDHE-ECDSA-AES128-GCM-SHA256 -curves prime256v1`.
- Rust binary (WebProof's `notarize.rs`/`present.rs`/`verify.rs` ported, tlsn git-pinned): prover
  with a POST body against the Node server, notary in a second process over TCP, presentation
  to disk, offline verify printing request line / status / body, hand-rolled predicate check.
- EIP-712 verdict: define the `Verdict` type string, field encoding and domain
  (`Fermata`/`1`/`chainId`/`escrow`) once; sign with k256 (`sign_prehash_recoverable`, low-s,
  `v = 27 + recid`); cross-check the same key and digest with Foundry `vm.sign` and viem
  `hashTypedData` — byte-identical `(r, s, v)` is part of the gate.
- Minimal `settle`-only contract accepting the signature: on `anvil --chain-id 42431` first, on
  Moderato when the RPC is reachable.
- Measure: prove-time (MPC mode, two processes) and proxy mode, presentation size, and any
  TLS/HTTP constraint hit. Record in FACTS §15.

**Probe 2 — custom MPP method** (`spikes/mpp-method/`, TypeScript)
- 30-line `mppx/server` (Hono) offering `compose(['tempo/charge', { testnet: true, … }], ['probe/charge', …])`.
- Client A with the `probe` plugin (`Method.toClient`) pays via `probe`; client B (vanilla
  `tempo`) falls back. Confirm the `stableBinding` override for a per-challenge id, that
  `validate` may be async, that `Errors.VerificationFailedError` yields 402, and that
  overwriting `Payment-Receipt` after `withReceipt` works (FACTS §10). The tempo leg needs the
  RPC; the custom-method leg does not.

**Probe 3 — TIP-20 permit + `transferFromWithMemo`** (`spikes/tip20/`, Foundry + viem)
- Mock built from `ITIP20.sol` copied verbatim (exact return types), with EIP-2612 `permit`
  (domain `name()`/`"1"`/chainId/token, `nonces`), on `anvil --chain-id 42431`.
- Then on Moderato: fund two wallets via `tempo_fundAddress`, sign a permit with viem, call a
  probe contract that does `permit` + `transferFromWithMemo`, read the `TransferWithMemo` log
  back by memo, and record how the fee was charged (fee token, amount) — Anvil cannot show this.

Gate: all three green → Milestone 1. Any red → stop and report.

## Milestone 1 — escrow contract (done locally 2026-09-24)

Interface as in `PROMPT.md` plus Bilgin's three decisions (settle only inside the window;
serviceId = registrant address ‖ 12-byte label, checked on-chain, verifier trust checked in the
SDK; timeout refunds emit `Refunded` with a zero presentationHash).

Acceptance:
- [x] `forge test`: 43 unit/fuzz + 3 vector (Rust-signed verdict settles) + invariant suite
  (128 runs × 64 calls, `fail_on_revert`, mutation-checked); `FOUNDRY_PROFILE=tempo forge test
  --network tempo`: 5 tests on the real pathUSD precompile and TIP-403 registry. Coverage of
  `FermataEscrow.sol` 97.9 % lines / 92.3 % branches.
- [x] Deploy script: `pnpm escrow:deploy --chain moderato|anvil` (`contracts/script/Deploy.s.sol`
  via `forge script --network tempo`, then `scripts/export-deployment.ts`).
- [x] Address + ABI in `packages/sdk/src/deployments.json` (anvil entry now; moderato on deploy).
- [x] Round trip from a script: `pnpm escrow:roundtrip --chain anvil|moderato` — DELIVERED,
  FAILED and TIMEOUT, each reconciled from `TransferWithMemo` logs by callId alone;
  `pnpm escrow:e2e:anvil` runs deploy + round trip on a fresh Anvil in ≈ 25 s.
- [ ] Moderato run with explorer links — DEFERRED (RPC 403). Keys already exist
  (`pnpm keys:init`); needs faucet funding, `pnpm escrow:deploy --chain moderato`,
  `pnpm escrow:roundtrip --chain moderato`.

Deviations from the M1 plan: no 1-unit escrow seed (storage credits already refund the balance
slot, FACTS §15.1); invariant `fail_on_revert = true` so handler assertions cannot be swallowed;
spike gate hardened (notary-key poll — a `pipefail` bug aborted the probe silently whenever
the notary took longer than an instant to print its key —, 30 s × 3 prove attempts, `tee` fix).
Faked: nothing on-chain; the round trip's verdicts are signed by a script-held verifier key over
placeholder presentation/response hashes — Milestone 2 replaces them with real presentations.

Open risks: (1) per-call gas — one permanent slot per callId, so a hold is ≥ ~337k gas
(~825k when holds overlap, 1.57M for a fresh agent's first hold); at 1e10 attodollars/gas that
first hold costs ~$0.016 > the $0.01 demo price — revisit the price once Moderato's fee per gas
is measured; (2) Moderato unreached from this environment; (3) MPC hangs → M2 needs
per-attempt timeouts and retries.

## Milestone 2 — attestor (done locally 2026-09-29)

`apps/attestor` (`fermata-attest notary | prove | verify [--offline] | serve | hashes`), its own
cargo workspace on Rust 1.95.0 with tlsn pinned to `47aee45b`; `apps/vendor` (Node TLS 1.2 demo
vendor, `/v1/quote?symbol=`, `CHAOS=500|truncate|cut|hang`, `CHAOS_RATE`). Bilgin's decisions:
hand-rolled `eth_call` (no alloy); `originHash`/`notaryKeyHash` = keccak of canonical strings;
reveal everything except auth header values; vendor app now.

Acceptance:
- [x] `prove` against the demo vendor over local TLS through a separate notary; `verify` pins the
  notary key via `notaryKeyHash`, evaluates the predicate, signs the EIP-712 verdict; `--offline`
  re-checks a downloaded presentation with no chain or key; `serve` exposes it over HTTP.
- [x] Binding checks before any signature: notary, origin, request (incl. redaction policy),
  predicate, hold open, plus the two added (callId header, TLS session time inside the window).
  One negative test each, plus tampering and a no-transcript case (`tests/attest.rs`).
- [x] Rust integration test → `contracts/test/fixtures/attest-vector.json` →
  `AttestVector.t.sol`: the DELIVERED verdict releases, the FAILED (authenticated 500) verdict
  refunds, a verdict cannot settle another call.
- [x] Prove time recorded (FACTS §15.2): median 1.30 s per call, well under the 10 s alarm.
- [x] Live: `pnpm attest:e2e:anvil` — hold → attest → settle for DELIVERED and FAILED, replayed
  proof refused, offline re-verification against on-chain hashes, no transcript → no verdict →
  timeout refund.
- [ ] Moderato — DEFERRED with the rest of the chain work (RPC 403 in this environment).

Deviation: no `docker-compose.yml` yet (no Docker daemon here, and the gateway it would wire up is
Milestone 3); it lands with the gateway. Faked: nothing — M1's placeholder verdicts are replaced
by real presentations in the e2e run (the `escrow:roundtrip` script still uses placeholders, by
design, to test the escrow alone).

Open risk: MPC setup stalls (≈ 16 % of sessions in a long-lived process, ≈ 5 % with a fresh
process each), absorbed by a 5 s setup bound + retry; if the 100-call load test suffers, `serve`
switches to a child process per proof.

## Milestone 3 — gateway, `fermata` method, SDK (done locally 2026-09-29)

Bilgin's decisions: settle, then respond (the receipt carries the settle tx); a gateway sweeper
calls `claimTimeout` after the window and the SDK has `reclaim(callId)`; call records are JSON
files.

Acceptance:
- [x] `packages/sdk`: `fermataMethod`, `fermata()` client (refuses an untrusted verifier / escrow /
  chain / token or a price mismatch before any money moves), `fermataServer()` (Held event with
  this callId/serviceId/requestHash/amount on this escrow, hold still open, one claim per callId),
  escrow bindings, `reconcile(token, callId)`, `reclaim(callId)`.
- [x] `apps/gateway`: `ANY /s/:serviceId/*` (402 with `fermata` + unprotected `tempo`), hold →
  attestor → settle → proved response + receipt `{callId, holdTx, txHash, presentationHash,
  outcome}`; the two failure branches exactly as the brief says (transcript → verdict → settle; no
  transcript → no verdict, `awaiting-timeout`, logged loudly, sweeper refund); `GET /proofs/:callId`,
  `/calls/:callId`, `/services`, `/openapi.json`, `/llms.txt`; refuses to start if the on-chain
  verifier or origin does not match the attestor.
- [x] Unit tests (10, fake chain + attestor) incl. replay and a credential reused on another
  request (mutation-checked); SDK 32 tests.
- [x] End-to-end Vitest through the whole stack (`pnpm gateway:e2e:anvil`): DELIVERED, FAILED,
  no answer → sweeper refund, each reconciled by memo; downloaded proof hashes to the on-chain
  `presentationHash`. Same test runs on Moderato with `FERMATA_E2E_CHAIN=moderato` + env.
- [x] Validator: 40 passed; the 3 failures are its Moderato payment phase (FACTS §15.3). It skips
  `fermata`, as recorded in the spike.
- [ ] Moderato e2e and validator payment phase — DEFERRED (RPC 403 here).
- `docker-compose.yml` + `apps/attestor/Dockerfile` written, not validated (no Docker daemon).

## Milestone 4 — demo agent, dashboard, `demo:cases`, `demo:load` (done locally 2026-09-29)

Bilgin's decisions: Vite + React dashboard served by the gateway at `/dashboard`; random
`CHAOS_RATE=0.03` for the load test.

Acceptance:
- [x] `bash scripts/demo-stack.sh up|down --chain anvil|moderato`: four vendors (3 % chaos, ok,
  always-500, never-answers), notary, attestor, gateway + dashboard; `out/demo/stack.json`.
- [x] `pnpm demo:cases` (definition of done): release / verified-failure refund / timeout refund,
  each checked on-chain, re-verified offline and reconciled by memo; pass/fail table with explorer
  links on Moderato — **3/3 PASS on Anvil**.
- [x] `pnpm demo:agent --calls N`: the brief's table (callId, outcome, txHash) and totals.
- [x] `pnpm demo:load --calls 100`: 97/3, 226.8 s, prove p50 1.13 s, 65.9 MB MPC traffic per call
  (FACTS §15.4).
- [x] Dashboard: live feed (calls + on-chain Held/Released/Refunded), per-call drawer (revealed
  transcript with auth masked, notary key, verdict signature, download proof, **re-verify offline**
  with recomputed vs on-chain hashes), Reconciliation tab (movements by memo, ✓ against the
  outcome), Services tab; light/dark, phone layout, fermata sign in the header. Screenshots in
  `docs/img/`.
- [ ] `demo:cases` / `demo:load` on Moderato — DEFERRED (RPC 403 here). Same commands with
  `--chain moderato` once the host is allowed.

Changes forced by measurements: the attestor proves in a child process per attempt (MPC setup
stalls in the long-lived server); `tempoChain` sets `blockTime: 1000` (receipt polling).

## Milestone 5 — submission polish (done locally 2026-09-29)

Bilgin's decisions: team is Bilgin Kocak, solo (location: Bilgin to fill in); the video is a
storyboard + raw headless recordings that Bilgin voices and edits; freeze on **2026-10-09**.

Acceptance:
- [x] README: pitch line, tagline, chargeback framing, "different from receipts", two Mermaid
  diagrams, "What the proof does and does not establish" and the v1 trust model verbatim (the one
  adjustment — no PSE notary, it was shut down — is footnoted, not silently edited), economics
  note, the six roadmap items, the exact quickstart (run from a fresh clone: forge 51, SDK 32,
  gateway 11, `demo:cases` 3/3), status and freeze. Mermaid checked with mermaid 11.
- [x] Freeze rule: demo, video and README frozen from 2026-10-09; afterwards only fixes a failing
  `pnpm demo:cases` justifies (README, SUBMISSION, here).
- [x] `docs/DEMO.md`: 2:40 storyboard (15 s problem, 20 s what Fermata is, 90 s the 100-call run,
  20 s reconciliation by memo, 15 s roadmap and ask), shot list, timed voice-over, live
  single-call fallback script, pre-record checklist.
- [x] Raw footage: `node scripts/record/record.mjs` → `out/video/{terminal-cases,dashboard-load,
  drawer-reverify,reconciliation}.webm` + stills (not committed; regenerate or attach to a release).
- [x] `docs/SUBMISSION.md` (Colosseum checklist, Tempo integration, go-to-market), `SECURITY.md`,
  logo `docs/img/logo.{svg,png}`.
- [x] `demo-stack.sh` fixes found by the fresh-clone run: honours `CARGO_TARGET_DIR`; a failed
  `up` stops whatever it already started.
- [x] Dashboard fix found in the footage: token amounts were rounded to 4 decimals (the vendor's
  0.00995 showed as 0.0100); they are now exact.
- [ ] Moderato run of `demo:cases` / `demo:load` and its explorer links — DEFERRED (RPC 403 here).
  Must happen before the 2026-10-09 freeze.
- [ ] Location, voice-over, edit, upload — Bilgin.

## Reused from WebProof (bilgin-kocak/webproof-solana @ 609a654, Apache-2.0)

Ported into `apps/attestor` with a header crediting WebProof: `notarize.rs` (prover + notary
halves, extended with arbitrary method/body and the socket-based notary), `present.rs`,
`verify.rs` (extended with the binding checks and EIP-712 signing), `tests/presentation.rs`
attack matrix, `fixture.rs`, the git-pinning and `opt-level = 3` Cargo pattern. Not reused:
Anchor program, Borsh claim format, Ed25519 signing, TypeScript SDK.

## Decisions for Bilgin at this review

1. The two added binding checks (6 and 7 above). Proposed: yes.
2. Disclosure policy: reveal the full response and all request headers except
   `Authorization`/`Cookie`/`Proxy-Authorization` (name only) — WebProof's policy, within the
   prompt's "body or selected byte ranges". Proposed: yes for v1.
3. Proxy mode (1–2 s, verifier relays the encrypted stream) as an opt-in for the 100-call load
   test only, decided on the spike's numbers. Proposed: measure first, default MPC mode.
4. Notary signature algorithm `SECP256K1ETH` (ecrecover-compatible, keeps "on-chain
   presentation verification" a credible roadmap item). Proposed: yes if it verifies at the tag.
5. `mppx` pin 0.11.0 (released 2026-09-23) vs 0.10.1. Proposed: 0.11.0, fall back on trouble.
6. Docker: no daemon in the build environment; `docker-compose.yml` is written but validated
   only on Bilgin's machine. Proposed: accept.
