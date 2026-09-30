# DEMO.md — the video (2:40) and the live demo

Target length **2:40** (limit 3:00). Voice-over at ≈ 150 words per minute; each beat's voice-over is
shorter than its slot (≈ 2:07 of speech in 2:40), leaving room to pause on the numbers. Everything shown is the real system — no mock-ups, no edited numbers.
Until the Tempo Moderato run is recorded, the footage is **Anvil's Tempo emulation** and the
lower-third says so ("local Tempo emulation, chain ID 42431").

Freeze: demo, video and README frozen from **2026-10-09**.

## Footage

Raw clips are recorded headless from a running stack (1280×720, webm, real time, nothing
re-timed). They are not committed; regenerate them:

```sh
bash scripts/demo-stack.sh up --chain anvil
# playwright-core is not a repo dependency: `npm i playwright-core` in any scratch directory
PW_CORE_DIR=<that directory> CHROMIUM=<path to chrome> node scripts/record/record.mjs --calls 100
bash scripts/demo-stack.sh down
```

| Clip (`out/video/`) | Length | What it shows |
|---|---|---|
| `terminal-cases.webm` | 37 s | `pnpm demo:cases`: the three canonical cases with ✓ checks and the pass/fail table |
| `dashboard-load.webm` | 4:25 | the Live tab for the whole `demo:load --calls 100` run; tiles count up, feed scrolls |
| `drawer-reverify.webm` | 39 s | a Released call's proof drawer → Re-verify offline (all ✓), then a Refunded one |
| `reconciliation.webm` | 25 s | the Reconciliation tab scrolling through memo matches, then the one-command check |
| `stills/*.png` | — | keyframes of each clip; five are committed as `docs/img/video-*.png` |

The recorded run (2026-09-29, Anvil): 100 calls, **95 released / 5 refunded** (the vendor fails at
random at 3 %, so a run lands anywhere around 97/3), 254.1 s wall-clock, 2.24 s per call (p50),
1.26 s MPC-TLS proving (p50), 65.9 MB MPC traffic per call. Quote these numbers with this footage;
`out/demo/load-anvil.json` has the full record.

![Final tiles of the recorded 100-call run](img/video-load-end.png)

Also needed, recorded by Bilgin: face or voice intro (optional), and a screen capture of a real
terminal for the live single call (below) if the video includes a live part.

## Storyboard

### 0:00–0:15 · The problem (15 s · VO 35 words ≈ 14 s)

**Picture:** black title card, 𝄐 logo, then a plain terminal line: an agent's `fetch` gets a
`500 Internal Server Error` after paying $0.01. Caption: *paid · 500 · no recourse*.

**Voice-over:**
> AI agents now pay for APIs per call — a cent here, a cent there. When the API fails, returns
> garbage, or never answers, the money is simply gone. There is no chargeback for machines.

### 0:15–0:35 · What Fermata is (20 s · VO 50 words ≈ 20 s)

**Picture:** the README's flow diagram (Mermaid, zoomed), animated left to right: *hold → proof →
release / refund*. Then `docs/img/logo.png` with the pitch line.

**Voice-over:**
> Fermata is the chargeback for machine payments — decided on cryptographic evidence instead of
> a support ticket. The agent's payment is held in escrow on Tempo. TLSNotary records exactly
> what the vendor's server sent. If it passes the agreed check, the vendor is paid. If not, the
> agent is refunded.

**On-screen text (hold 3 s):** *Receipts prove the buyer paid. Fermata proves what the seller
delivered.*

### 0:35–2:05 · The 100-call run (90 s · VO 164 words ≈ 66 s; the rest is picture)

| Time | Picture | Source |
|---|---|---|
| 0:35–0:50 | `terminal-cases.webm`, the three PASS blocks and the table | real time, cut to the three results |
| 0:50–1:25 | `dashboard-load.webm`, **sped up ≈ 7.5×** (label *"7.5× speed · 100 calls in 4 min 14 s real time"*); tiles count up, feed fills, Refunded rows appear | `stills/load-*.png` for the freeze-frames |
| 1:25–1:30 | freeze-frame on the final tiles: **100 held · 95 released · 5 refunded · 0 awaiting timeout** | `stills/load-end.png` |
| 1:30–2:05 | `drawer-reverify.webm`: open a Released call → transcript (auth header masked) → **Re-verify offline** → every hash ✓ next to the on-chain value; then a Refunded call showing the proved 500 | real time, trimmed |

**Voice-over:**
> Here is the whole thing, end to end. Three canonical cases: the vendor delivers, and it's paid.
> The vendor returns an authenticated 500, and the agent gets its money back. The vendor never
> answers — no transcript, no verdict — and after the settlement window the hold is refunded by
> the contract.
>
> Now a hundred calls. An agent buys a hundred quotes through Fermata, and the vendor fails about
> three percent of the time, at random. Every call is held on-chain, proven with TLSNotary, and
> settled — nobody touches anything. In this run, ninety-five
> released and five refunded — every failure proven, and paid back by the contract.
>
> Open any call. This is what the vendor's server actually sent, with the API key redacted. The
> proof is signed by the notary, and anyone can download it and re-verify it offline, with no
> key and no trust in us. Every recomputed hash matches the one on-chain. And this one — a real
> 500, proven, refunded.

### 2:05–2:25 · Reconciliation by memo (20 s · VO 37 words ≈ 15 s)

**Picture:** `reconciliation.webm`: rows with hold → release + fee, or hold → refund, each ✓;
end on the footer's one-line `cast logs` command.

**Voice-over:**
> Every movement is a Tempo TIP-20 transfer whose memo is the call's ID. So the books reconcile
> from the chain alone: hold, then release and fee, or refund — per call, one query, no database
> to trust.

### 2:25–2:40 · Roadmap and ask (15 s · VO 29 words ≈ 12 s)

**Picture:** roadmap list from the README, then the logo, the GitHub URL and *Pay on proof.*

**Voice-over:**
> Next: session escrow and sampled proving to bring the cost below a cent, and vendor-chosen
> verifiers. We're looking for API vendors selling to agents. Fermata — pay on proof.

**On-screen text:** github.com/bilgin-kocak/fermata · Tempo track · Colosseum Crypto World's Fair

## Claims the video may make (and may not)

- ✅ "Anyone can re-verify the evidence offline." ✅ "Refunds by rule: a verified failure or no
  proof in time." ✅ "Memo = call ID on every transfer."
- ❌ Never "trustless" or "decentralized adjudication": in v1 a disclosed Fermata verifier signs
  the verdict; independent verification is not independent adjudication.
- ❌ Never "the data is correct" — the proof shows what the server sent, not that the price is right.
- ❌ Never latency guarantees — the transcript has no trusted clock.
- ❌ Never "live on Tempo testnet" until the Moderato run exists; say "local Tempo emulation".

## Live single call (fallback / live demo, ≈ 60 s)

The brief allows showing the recorded 100-call run plus one live call.

1. `bash scripts/demo-stack.sh up --chain anvil` (before going live; ≈ 20 s with a built attestor).
2. Open `http://127.0.0.1:4300/dashboard` → **Live** tab, dark mode, browser at 1280×720.
3. In a terminal next to it: `pnpm demo:agent --calls 1 --service ok`. Point at the line
   `DELIVERED 0x…  HTTP 200`.
4. On the dashboard the call appears as *Held — proving*, then **Released** within ≈ 2 s.
5. Click it → drawer: transcript, notary key, verdict signature → **Re-verify offline** → all ✓.
6. **Download proof** — the `.tlsn` file is the evidence anyone can re-check.
7. `pnpm demo:agent --calls 1 --service e500` → **Refunded (verified failure)**; open it: the proved 500.
8. **Reconciliation** tab: both calls, memo = callId, ✓.

## Pre-record checklist

- [ ] `pnpm demo:cases` 3/3 PASS on the chain being shown; `demo:load` recorded on the same stack.
- [ ] Dashboard in dark mode, zoom 100 %, no other tabs/notifications; terminal font ≥ 16 px.
- [ ] Lower-third names the chain (Anvil Tempo emulation or Moderato with explorer links).
- [ ] No private keys on screen (`.env` never opened; Anvil keys are public dev keys).
- [ ] Numbers spoken match `out/demo/load-<chain>.json` and FACTS §15.4.
- [ ] Total ≤ 3:00; captions exported.
