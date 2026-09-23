# PLAN.md — milestones, estimates and design decisions

Status as of **2026-09-23**: Milestone 0 done; **Milestone S done — all three probes GREEN on
their local legs** (`spikes/README.md`); Moderato legs DEFERRED until the RPC is reachable from
the build environment (Bilgin: local GREEN unlocks Milestone 1). 19 days remain to 2026-10-12.
Freeze (demo, video, README) on **2026-10-09**, 72 h before the deadline, per the prompt.

## Calendar

| Milestone | Prompt estimate | Revised | Planned dates | Why the change |
|---|---|---|---|---|
| 0 Facts and plan | 0.5 d | 1 d (done) | 09-23 | doc hosts blocked → read GitHub sources; built tlsn |
| S Integration spike | 1–1.5 d | done in 1 d (09-23) | 09-23 | all local legs GREEN; Moderato legs deferred (RPC blocked) |
| 1 Escrow contract | 2 d | 2 d | 09-26 → 09-27 | unchanged; deploy needs the RPC |
| 2 Attestor | 3–4 d | 3.5–4 d | 09-28 → 10-01 | −1 d from the WebProof port, +0.5 d TCP notary + key handling, +0.5 d binding checks/tests |
| 3 Gateway + method + SDK | 3 d | 3 d | 10-02 → 10-04 | unchanged; receipt emission mechanism already found |
| 4 Vendor, agent, dashboard | 3 d | 3 d | 10-05 → 10-07 | unchanged; cut dashboard scope first if slipping |
| 5 Submission polish | 2 d | 1.5 d | 10-08 → 10-09 | README trust-model text already drafted in FACTS |
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

## Milestone 1 — escrow contract (2 d)

Interface exactly as in `PROMPT.md`. Implementation notes from FACTS: no `msg.value`, no
`code.length` checks (EIP-7702 delegated EOAs), hold record packed into as few slots as possible
(250k gas per new slot), `foundry.toml` `evm_version = "osaka"`, `ITIP20` with the exact TIP-20
signatures, Verdict EIP-712 domain `Fermata`/`1`/`block.chainid`/`address(this)`. Tests per the
prompt plus the cross-check vector from the spike. Deploy script to Moderato with the faucet
wallet; addresses and ABI to `packages/sdk/src/deployments.json`; explorer links to
`explore.testnet.tempo.xyz`; verification via `contracts.tempo.xyz` if reachable.

## Milestone 2 — attestor (3.5–4 d)

`apps/attestor` is its own cargo workspace (`rust-toolchain.toml` = 1.95.0; git deps pinned to
`47aee45b…`; `CARGO_TARGET_DIR` shared to avoid rebuilding tlsn). Subcommands
`prove | verify | serve | notary`.

Binding checks before any predicate evaluation (fail closed), the prompt's five plus two:
1. notary key hash equals the service's `notaryKeyHash` (`keccak256(alg ‖ SEC1 bytes)`);
2. `server_name` (case-insensitive) and the revealed `Host` header equal the registered origin,
   with the verifier root store restricted to the service's CA (Mozilla roots for public
   vendors via the `mozilla-certs` feature);
3. revealed method, path-with-query and body hash recompute to the on-chain `requestHash`, with
   every contributing byte range inside `sent_authed()`;
4. the predicate JSON hashes to `predicateHash`;
5. the hold is open on-chain (no verdict, deadline not passed);
6. *(added)* the revealed `X-Fermata-Call` request header equals `callId`, so an old
   presentation for an identical request cannot unlock a new hold;
7. *(added)* `connection_info.time` lies inside the hold window.
One negative test per check. No JSON-body assumption in the verifier: the predicate decides.
`presentationHash = keccak256(bincode bytes)` (bincode 1.3.3 is part of the format). Notary
signature algorithm `SECP256K1ETH` if `Secp256k1EthSigner` verifies under the default provider,
else `SECP256K1`. EIP-712 signing with k256 + keccak (both already in the dependency tree; no
alloy). Integration test against the in-process `tlsn-server-fixture` and the demo vendor;
verdict fixture exported for the Foundry test.

## Milestone 3 — gateway, `fermata` method, SDK (3 d)

Hono + `mppx@0.11.0`. `fermata` method: `request` hook computes `requestHash` and mints
`callId`; `stableBinding` compares `serviceId`, `amount`, `currency`, `requestHash` (not
`callId`); `validate` (async) reads the hold tx receipt's `Held` log and the open hold, throwing
`Errors.VerificationFailedError` on any mismatch or RPC error; `broadcast` returns the hold
receipt; `Store.tryClaim` on `callId` with idempotent re-presentation. The route handler then
proves (attestor `serve`), verifies, settles from the relayer wallet, and overwrites
`Payment-Receipt` with `Receipt.serialize({ …, callId, txHash, presentationHash, outcome })`.
Fallback `tempo` charge composed into the same 402, tagged `unprotected`. `/openapi.json`
discovery. Report the validator's exact output for both methods.

## Milestone 4 — demo vendor, agent, dashboard (3 d)

Vendor per FACTS §12.4 with `CHAOS_RATE`; agent loop with the table and totals; dashboard with
live events, proof drawer (re-verify via the attestor), reconciliation by `TransferWithMemo`
memo. `pnpm demo:cases` (definition of done) and `pnpm demo:load --calls 100`. Localhost
measurement (FACTS §15: 1.2 s per in-process session) extrapolates to ≈ 2–3 min for 100 calls
plus on-chain time; if the two-process variant is slower than the video allows, record the run
in advance and show one live call, as the prompt permits.

## Milestone 5 — submission polish (1.5 d)

README per the prompt, with the trust-model paragraph amended for the own-notary design and the
economics note using measured numbers; `docs/DEMO.md`; `SECURITY.md`; submission checklist.

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
