# PITCH.md — the presentation video (2–3 min)

Colosseum asks for **two** videos: this 2–3 minute presentation ("one of the first resources judges
review") and a product demo of at most 3 minutes ([`DEMO.md`](DEMO.md)). This one is a startup
pitch, spoken over the deck: [Fermata — Pay on proof](https://claude.ai/artifact/AB3JHTSCyQBLXxTi55EZwS)
(share it before submitting). Each section below is one or two of its ten slides.

- **Length:** about 310 spoken words; a natural read takes about 3:00.
- **Recording:** the deck full screen, your voice; your face in a corner, at least on the cover and the
  ask: judges score the founder too. One take per slide is fine; cut the pauses.
- **Before recording:** record the demo video's Claude scene first, so the "It works" line about
  Claude is also shown on testnet. Say only what is true; drop a sentence rather than guess a number.

## Script

### 0:00–0:18 · Cover — who and what (≈ 38 words)

> AI agents now pay for APIs per call. When the API fails, the money is gone. I'm Bilgin Kocak; I
> built WebProof, a TLSNotary verifier, and Fermata grew out of it. This is Fermata: pay on proof.

### 0:18–0:40 · The problem (≈ 44 words)

> Agents pay over x402, or MPP from Stripe and Tempo, before the answer arrives. And APIs fail: a
> 500, broken JSON, or silence. A receipt proves the buyer paid, not that the seller delivered, and
> MPP's own docs leave refunds up to the service.

### 0:40–1:00 · The solution (≈ 43 words)

> Fermata holds the payment in escrow on Tempo. TLSNotary records exactly what the vendor's server
> sent, and that record is checked against a rule pinned on-chain. Delivered: the vendor is paid. A
> proven failure, or no proof in time: the agent is refunded automatically.

### 1:00–1:15 · Built on Tempo (≈ 33 words)

> On Tempo, every hold, payout and refund carries the call ID as its memo, so the books reconcile
> from chain logs alone. Agents pay with a new MPP method, or through MCP tools.

### 1:15–1:35 · It works (Moderato, then Real vendors) (≈ 43 words)

> It runs on Tempo's testnet today, at a public URL. A hundred paid calls against a vendor that
> fails at random: ninety-six released, four refunded, zero errors. It also proves the real npm
> registry, and Claude can pay through it and get refunded.

### 1:35–1:42 · Why it's different (compare) (≈ 15 words)

> Designs like Recourse need the seller's own signature and a bonded dispute. Fermata needs neither.

### 1:42–2:02 · Business and economics (≈ 41 words, plus the optional validation line)

> Fermata takes half a percent of released payments, nothing on refunds. First customers: API vendors
> already selling to agents, who get chargeback-grade trust without building it. [Optional, only if
> true: "I've talked to N vendors; M want to pilot it."] At scale we'll prove a random five percent of
> calls, cutting the proving cost twentyfold.

### 2:02–2:27 · Trust, roadmap and the ask (≈ 53 words)

> To be clear about trust: in version one, we sign the verdicts and run the notary. Every verdict
> points at a proof anyone can re-check, so a dishonest verdict is detectable, and the roadmap
> removes us from the trust path. We're looking for pilot vendors, agent builders, and the
> accelerator. Fermata: pay on proof.

## What each line rests on

| Spoken | Source |
|---|---|
| WebProof → Fermata | `apps/attestor/src/lib.rs` (TLSNotary code ported from github.com/bilgin-kocak/webproof-solana); disclosed as prior work in the submission |
| MPP is from Stripe and Tempo | FACTS §9: MPP is co-authored by Stripe and Tempo |
| MPP leaves refunds up to the service | mpp.dev's refund docs: "Refund decisions are up to your service" |
| 100 calls through the public URL: 96 released, 4 refunded, 0 errors | README "Measured", run through the live demo on 2026-10-05 |
| Runs on Tempo's testnet; real npm registry | README; `deploy/smoke.sh` 7/7 against the live URL |
| Claude can pay through it and get refunded | `pnpm demo:mcp` 6/6 against the live gateway; a real Claude Code session in `apps/mcp/README.md`; the demo video shows it live |
| Recourse needs the seller's signature and a bonded dispute | README "How Fermata compares" (checked against its repository) |
| Half a percent on releases, nothing on refunds | `feeBps = 50` on-chain; refunds never charge a fee |
| Five percent sampling cuts the proving cost twentyfold | the deck's economics slide: 65.9 MB measured per proof at an assumed $0.09/GB, × 5 % ≈ $0.0003 of bandwidth per call — a plan, not built |

## Don't say

- "Trustless", "decentralized adjudication" or "no trust in us": in v1 our verifier signs the
  verdicts and we run the notary.
- That any cheating is detectable: only a verdict that contradicts its proof is. While we run both
  the prover and the notary, a forged transcript would still re-verify (README, Trust model, note ²).
- That the data is correct: the proof shows what the server sent, not that a price is right.
- Market-size figures or traction you can't back with a source.
- That sampled proving, session escrow or vendor-chosen verifiers exist: they are the roadmap.
