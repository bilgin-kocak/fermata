# Milestone S — integration spike (throwaway code)

Three probes that find where the Fermata design breaks before any product code is written.
Run `./gate.sh` (sequentially; never run the probes in parallel — the MPC-TLS session deadlocks
under CPU contention on small machines). Each `run.sh` ends with `PROBE n: GREEN | RED(reason) |
DEFERRED(reason)`. Environment: 4 vCPU, Rust 1.95.0, Foundry 1.8.3, Node 22, tlsn v0.1.0-alpha.15.
Moderato legs are DEFERRED while the Tempo RPC is unreachable from the build container; Bilgin
decided local GREEN unlocks Milestone 1 (2026-09-23).

**PROBE 1: GREEN** — `proof-path/` (≈4 h). Proved: a Node TLS-1.2 vendor (P-256 ECDSA leaf,
`ECDHE-ECDSA-AES128-GCM-SHA256`, local OpenSSL CA) can be proven by a tlsn prover talking to a
**separate TCP notary process** (SECP256K1ETH attestation signatures); POST bodies work; the raw
whole-transcript commitment makes a **500** and a **truncated-JSON** response attestable (both
yield `FAILED` verdicts instead of errors); wrong notary key / origin / callId / a flipped byte
are rejected; the Rust EIP-712 digest and signature match Foundry `vm.sign` byte for byte;
`SpikeSettle.settle` on Anvil (chain 42431) accepts the Rust-signed verdict and rejects replay.
Numbers: MPC mode prove wall-clock median **1.1–1.5 s** (runs 0.93–2.5 s; two processes on 4 vCPU),
proxy mode **0.46–0.51 s**, presentation **5,162 bytes** (raw + HTTP-structured commitments;
1,916 bytes with raw only), verify **< 10 ms**. Moderato settle: DEFERRED (rpc blocked).

**PROBE 2: GREEN** — `mpp-method/` (≈3 h). Proved: with `mppx@0.11.0` a custom `probe` charge
method built with `Method.from/toServer/toClient` (no fork) is offered next to `tempo` in one
402 (two `WWW-Authenticate` values); a plugin client pays via `probe`; a vanilla tempo client
selects `tempo`; per-request `compose` carries `requestHash` as a route option and the paid
retry passes the stable-binding check; the receipt can be overwritten after `withReceipt` to
carry `callId`/`outcome`; replaying a credential → 402 `verification-failed`; a plain `Error`
in `validate` → HTTP 500 (`VerificationFailedError` is mandatory). Validator
(`npx mppx validate`): 15 passed, 1 failed = the faucet-funded tempo payment (rpc blocked);
`probe` is listed in the challenge check and silently skipped in the payment phase; see
`mpp-method/logs/validator.txt` after a run. Moderato tempo payment: DEFERRED.

**PROBE 3: GREEN** — `tip20/` (≈2 h). Proved: `permit` + `transferFromWithMemo` in one
transaction (the escrow's `hold` shape) against a TIP-20 with the exact `ITIP20` signatures,
both on a mock (`forge test`, 3 tests incl. reused permit / bad v / expired) and on **Anvil
1.8.3's built-in Tempo emulation** (chain id 42431 → real TIP-20 precompile at `0x20c0…0000`,
name `PathUSD`, EIP-2612 domain verified against `DOMAIN_SEPARATOR()`); the `TransferWithMemo`
log is found by memo topic; fees were charged to the **relayer in AlphaUSD** (5,977 units ≈ $0.006
for 567k gas) with no fee token set, tx type EIP-1559. Moderato: DEFERRED.

Design consequences carried into `docs/PLAN.md`: raw whole-transcript commitments; `requestHash`
computed by the route from the cloned body; the gateway must expose `/openapi.json` and
`/llms.txt`; proxy mode is a viable 2–3× speed-up for the load test only.
