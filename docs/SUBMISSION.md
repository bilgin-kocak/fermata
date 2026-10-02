# Colosseum submission checklist — Fermata

Crypto World's Fair, **Tempo track**. Deadline **2026-10-12**; demo, video and README frozen from
**2026-10-09** (after that, only fixes that a failing `pnpm demo:cases` justifies).

Legend: ✅ ready · ⏳ pending · ✍️ Bilgin to fill in

| Field | Status | Value / where |
|---|---|---|
| Product name | ✅ | Fermata |
| Tagline | ✅ | Pay on proof. |
| One-liner | ✅ | Chargebacks for machine payments, decided on cryptographic evidence instead of a support ticket. |
| Description | ✅ | [below](#description) |
| Tempo integration | ✅ | [below](#tempo-integration) |
| Team | ✅ | Bilgin Kocak (solo) — GitHub [@bilgin-kocak](https://github.com/bilgin-kocak) |
| Location | ✅ | Eskişehir, Turkey |
| Logo (𝄐) | ✅ | [`docs/img/logo.svg`](img/logo.svg), [`docs/img/logo.png`](img/logo.png) (512×512) |
| GitHub link | ✅ | https://github.com/bilgin-kocak/fermata (make sure `main` is the default branch) |
| Video (2–3 min) | ⏳ | storyboard + voice-over in [`DEMO.md`](DEMO.md); raw clips via `scripts/record/`; **TODO (Bilgin): record VO, edit, upload, paste link** |
| 3-minute demo | ⏳ | same video; the live part follows DEMO.md's "live single call" script |
| Go-to-market | ✅ | [below](#go-to-market) |
| Screenshots | ✅ | [`docs/img/`](img/) |

## Description

AI agents already pay for APIs per call over HTTP 402 (MPP, x402). What they can't do is get their
money back: a receipt proves the agent paid, not that the API delivered. If the API returns a 500,
truncated JSON or nothing at all, the payment is gone.

Fermata is the chargeback for machine payments, decided on evidence instead of a support ticket.
The agent's payment is **held** in an escrow contract on Tempo. The Fermata gateway forwards the
call through TLSNotary, which produces a cryptographic record of exactly what the vendor's HTTPS
server sent. If that record passes a delivery predicate the vendor registered up front (status
code, content type, body size, JSON shape — nothing that needs a trusted clock), the escrow
**releases** the payment to the vendor, minus a 0.5 % fee. If the record shows a failure, the
agent is **refunded**. If there is no record at all, the agent reclaims the hold after the
settlement window. Every movement is a TIP-20 transfer whose memo is the call's ID, so each call
reconciles from on-chain logs alone.

Agents add one line to their `mppx` client (`fermata({ account })`); vendors register a service
and keep their API unchanged. The gateway also offers plain `tempo` payments, tagged
`unprotected`, so existing MPP clients keep working. MCP agents such as Claude get the same
protection as tools: one `claude mcp add` gives Claude pay-on-proof APIs.

Trust model (v1), stated plainly: the escrow trusts one verifier key per service, held by
Fermata; the notary is a separate, blind process that we run in the demo. A vendor trusts
Fermata to sign honest verdicts — but every verdict points at a proof anyone can download and
re-verify offline, so a dishonest verdict is detectable and the evidence is portable. Vendor-chosen
verifiers, an N-of-M quorum and on-chain proof verification are on the roadmap.

## Tempo integration

- **TIP-20 memos as the call ledger.** The hold is pulled with `transferFromWithMemo(agent →
  escrow, price, memo = callId)`; release pays the vendor and treasury, and refunds pay the
  agent, with `transferWithMemo(…, memo = callId)`. `TransferWithMemo` logs alone reconcile every
  call (SDK `reconcile`, the dashboard's Reconciliation tab, or one `cast logs` command).
- **TIP-20 permit.** The agent signs an EIP-2612 permit; `hold` does permit + pull in one
  transaction, so an agent needs no separate approval.
- **`FermataEscrow`** (Solidity 0.8.30, Foundry): per-call holds, EIP-712 verdicts, timeout
  refunds callable by anyone. Checks recipients against the TIP-403 registry, rejects TIP-20
  addresses as payout, and clears hold slots on finalisation so Tempo storage credits (TIP-1060)
  refund most of the next hold's storage cost. Tested against the real TIP-20 precompile
  (`forge test --network tempo`).
- **MPP.** A custom `fermata` payment method for `mppx` (client + server): the 402 challenge
  carries the escrow, serviceId, callId, requestHash, amount and deadline; the credential is the
  hold transaction. It is offered next to Tempo's built-in `tempo` method in every challenge.
- **Real vendors.** Besides the mock vendor, Fermata proves the public npm registry. The vendor's
  certificate chains to Mozilla's roots and the call goes over the open internet. A real 200 was
  released and npm's real 404 refunded, about 2 s per proof (`pnpm demo:real`, FACTS §15.6).
  Coinbase spot price is wired up for a local run.
- **MPP over MCP.** The gateway's `/mcp` endpoint exposes every service as a paid MCP tool, using
  mppx's MCP transport with the `fermata` method. `fermata-mcp` lets Claude Code or Claude Desktop
  pay those tools from a testnet wallet, with the agent's own allow-lists and a spending cap. In a
  real headless Claude Code session, Claude bought two quotes: one released, and a proven HTTP 500
  refunded. It then re-verified the proof (`apps/mcp/README.md`).
- **Stablecoin gas.** Agents pay gas in the same TIP-20 stablecoin (pathUSD on testnet); the demo's
  totals report escrow fee and gas separately.
- **Network:** Tempo Moderato testnet, chain ID 42431, explorer `explore.testnet.tempo.xyz`.
  FermataEscrow on Moderato: [`0x88A9886B99aC8a93475dEFBda6245161Cd1F0763`](https://explore.testnet.tempo.xyz/address/0x88A9886B99aC8a93475dEFBda6245161Cd1F0763)
  ([deploy tx](https://explore.testnet.tempo.xyz/tx/0x96e0a6682f522f6920a3104de329f45a96e804968ac3a3cc98600bcc1b5e174a)).
  `demo:cases --chain moderato` 3/3 PASS — release
  [hold](https://explore.testnet.tempo.xyz/tx/0xb9d627e454bb9496a50d6dac9fe17d4fb2e4f3a4a04d401e183a447f6cdcf84b) /
  [settle](https://explore.testnet.tempo.xyz/tx/0xd480381bb6f5ba8135065bdf228d6fd863069f942c61f4c092d27dd02d3b4463), verified-failure refund
  [hold](https://explore.testnet.tempo.xyz/tx/0x0475e28b8095eaef2164eb85527b9810abdf182583477d1a3c27fdd823b40741) /
  [refund](https://explore.testnet.tempo.xyz/tx/0x65650d96981a6f40d360112ffba952c5003c9394be2f301e6ff7ef6ae4e1ce10), timeout refund
  [hold](https://explore.testnet.tempo.xyz/tx/0x1afc771c3bf299f494ec49b240d0e3e57aab54cc9e889bdb8693a0ec0fecfbc6) /
  [refund](https://explore.testnet.tempo.xyz/tx/0x3da2db644387a15b54a8e568639446cc4b820deb6e4372e96d7eaee6149d2c4d).
  100-call load on Moderato: 96 released, 4 refunded, 0 errors.

## Go-to-market

- **First customers:** API vendors already selling to agents via MPP or x402 — data APIs (quotes,
  search, enrichment), inference endpoints, scraping and tool APIs priced per call.
- **Wedge:** they get chargeback-grade trust without building it. An agent (or the agent's owner)
  can safely route spend to a vendor it has never seen, because a failed call is refunded by rule.
  That is a conversion argument for the vendor, not a cost: they register once, and their API
  doesn't change.
- **Business model:** 0.5 % fee on released payments (on-chain, `feeBps = 50`); nothing on refunds.
- **Path to scale:** session escrow, sampled proving and prove-on-dispute bring proving cost below
  one-cent calls (see the README's economics note: today ≈ 1.1 s and ≈ 66 MB of MPC traffic per
  proven call); vendor-hosted gateways and vendor-chosen verifiers remove Fermata from the trust path.

## Before submitting

- [x] Location filled in above.
- [x] `bash scripts/demo-stack.sh up --chain moderato && pnpm demo:cases --chain moderato` →
      3/3 PASS with explorer links (2026-10-01; links and escrow address above and in the README).
- [x] `pnpm demo:load --calls 100 --chain moderato` → 96/4, 0 errors (the recorded footage is Anvil; keep its caption).
- [ ] ✍️ Video recorded, edited, uploaded; link pasted above.
- [ ] `main` is the default branch on GitHub; README renders (Mermaid diagrams, logo).
- [ ] Claims audit: nothing in the README, video or this form claims more than the v1 trust model.
- [ ] Freeze respected (2026-10-09).
