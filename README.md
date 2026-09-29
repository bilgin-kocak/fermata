# 𝄐 Fermata — Pay on proof

**Chargebacks for machine payments, decided on cryptographic evidence instead of a support ticket.**

Fermata holds an agent's [Tempo](https://tempo.xyz) payment for an API call until an independently
verifiable record of the vendor's HTTPS response (a [TLSNotary](https://github.com/tlsnotary/tlsn)
presentation) passes a pre-agreed, mechanically checkable delivery predicate. A verified failure, or
an expired proof window, returns the payment to the agent.

**How this differs from x402/MPP receipts:** receipts prove the buyer paid. Fermata proves what the
seller delivered, holds the money until that check passes, and refunds by rule when it doesn't.

Vocabulary: `hold → release(proof) → refund`.

## Status

Milestones 1–4 done locally (escrow, attestor, gateway + `fermata` MPP method + SDK, demo + dashboard); Moderato deployment pending network access.

- [`contracts/src/FermataEscrow.sol`](contracts/src/FermataEscrow.sol): `hold → settle(verdict) | claimTimeout`,
  TIP-20 permit + `…WithMemo` transfers with memo = callId, EIP-712 verdicts.
- [`apps/attestor`](apps/attestor): `fermata-attest` — proves the vendor's HTTPS response with TLSNotary,
  binds it to the on-chain hold, evaluates the delivery predicate and signs the verdict.
- [`apps/gateway`](apps/gateway): the MPP gateway agents pay — `fermata` (escrowed, pay on proof) or `tempo` (unprotected).
- [`packages/sdk`](packages/sdk): `fermata()` client + `fermataServer()` for `mppx`, escrow bindings, `reconcile`, `reclaim`.
- [`apps/dashboard`](apps/dashboard): live feed, per-call proof drawer with offline re-verify, reconciliation by memo.
- [`apps/vendor`](apps/vendor): demo vendor (TLS 1.2 quote API) with failure modes.
- [`docs/FACTS.md`](docs/FACTS.md): verified facts about Tempo, MPP and TLSNotary, with sources, dates and measurements.
- [`docs/PLAN.md`](docs/PLAN.md): milestone plan, status and open risks.
- [`PROMPT.md`](PROMPT.md): the build brief.

## Demo

![Dashboard: a released call re-verified offline against the chain](docs/img/dashboard-reverify.png)

```sh
bash scripts/demo-stack.sh up --chain anvil    # vendors, notary, attestor, gateway + dashboard
pnpm demo:cases --chain anvil                  # release / verified-failure refund / timeout refund
pnpm demo:load --calls 100 --chain anvil       # ≈97/3, timings, MPC bandwidth, gas
open http://127.0.0.1:4300/dashboard           # live feed, proof drawer, reconciliation by memo
bash scripts/demo-stack.sh down
```

## Economics (measured, FACTS §15.4)

Per-call MPC proving is too slow and too bandwidth-heavy for one-cent calls at scale. In the
100-call load test every call cost **≈ 1.1–1.4 s of MPC-TLS and ≈ 66 MB of prover↔notary
traffic** on top of two transactions (hold ≈ 345k gas, settle ≈ 107k gas) — for a $0.01 quote.
v1 proves every call to demonstrate the mechanism end to end. The production shape: **session
escrow** (hold once for N calls, settle in batches), **sampled proving** (prove a random,
unpredictable subset; the vendor cannot tell which calls are checked) and **prove-on-dispute**
(proofs only when the agent flags a call, with the hold covering the dispute window).

## Quickstart

Requires Foundry 1.8.3, Node ≥ 22.21, pnpm 10 and (for the attestor) Rust 1.95.0 via rustup.

```sh
git submodule update --init && pnpm install
cd contracts && forge test                                  # unit, fuzz, invariant, Rust vectors
FOUNDRY_PROFILE=tempo forge test --network tempo            # against the real TIP-20 precompile
cd .. && pnpm sdk:test                                      # viem EIP-712 == Rust == Solidity
pnpm escrow:e2e:anvil     # anvil --chain-id 42431: deploy + DELIVERED/FAILED/TIMEOUT round trip
pnpm attest:test          # attestor unit + integration tests (real MPC-TLS; needs node, openssl, Rust 1.95)
pnpm attest:e2e:anvil     # hold → TLSNotary proof → verdict → settle, every component a real process
pnpm gateway:test         # gateway unit tests
pnpm gateway:e2e:anvil    # an mppx agent pays through the gateway: DELIVERED / FAILED / no answer → refund

# Tempo Moderato testnet
pnpm keys:init            # writes .env with fresh testnet keys; prints faucet commands
pnpm escrow:deploy --chain moderato
pnpm escrow:roundtrip --chain moderato
```

Hackathon submission for the Tempo track of Colosseum's Crypto World's Fair (deadline 2026-10-12).
Testnet only (Tempo Moderato, chain ID 42431). Unaudited hackathon code.
