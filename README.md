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

Milestone 1 (escrow contract) done locally; Moderato deployment pending network access.

- [`contracts/src/FermataEscrow.sol`](contracts/src/FermataEscrow.sol): `hold → settle(verdict) | claimTimeout`,
  TIP-20 permit + `…WithMemo` transfers with memo = callId, EIP-712 verdicts.
- [`docs/FACTS.md`](docs/FACTS.md): verified facts about Tempo, MPP and TLSNotary, with sources, dates and measurements.
- [`docs/PLAN.md`](docs/PLAN.md): milestone plan, status and open risks.
- [`PROMPT.md`](PROMPT.md): the build brief.

## Quickstart

Requires Foundry 1.8.3, Node ≥ 22.21 and pnpm 10.

```sh
git submodule update --init && pnpm install
cd contracts && forge test                                  # unit, fuzz, invariant, Rust vectors
FOUNDRY_PROFILE=tempo forge test --network tempo            # against the real TIP-20 precompile
cd .. && pnpm sdk:test                                      # viem EIP-712 == Rust == Solidity
pnpm escrow:e2e:anvil     # anvil --chain-id 42431: deploy + DELIVERED/FAILED/TIMEOUT round trip

# Tempo Moderato testnet
pnpm keys:init            # writes .env with fresh testnet keys; prints faucet commands
pnpm escrow:deploy --chain moderato
pnpm escrow:roundtrip --chain moderato
```

Hackathon submission for the Tempo track of Colosseum's Crypto World's Fair (deadline 2026-10-12).
Testnet only (Tempo Moderato, chain ID 42431). Unaudited hackathon code.
