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

Milestone 0 (facts and plan) — no product code yet.

- [`docs/FACTS.md`](docs/FACTS.md): verified facts about Tempo, MPP and TLSNotary, with sources and dates.
- [`docs/PLAN.md`](docs/PLAN.md): milestone plan and estimates.
- [`PROMPT.md`](PROMPT.md): the build brief.

Hackathon submission for the Tempo track of Colosseum's Crypto World's Fair (deadline 2026-10-12).
Testnet only (Tempo Moderato, chain ID 42431). Unaudited hackathon code.
