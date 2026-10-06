# DEMO.md — the product-demo video (≤ 3:00)

Colosseum asks for two videos: a 2–3 minute presentation ([`PITCH.md`](PITCH.md)) and a product demo
"of no more than three minutes explaining how the product works". This is the demo. It is recorded on
the **live demo on Tempo Moderato testnet**, <https://fermata-production-9378.up.railway.app/dashboard/>:
every payment you show is real and has an explorer link.

Target **2:45**. The voice-over below is about 245 words (≈ 1:55 at a relaxed 130 words per minute),
which leaves about a minute for the clicks and the waits. Freeze: demo, video and README frozen from **2026-10-09**.

## Before recording

1. **Per-visitor limits.** You will click several buttons in a row, so relax the limits for the
   recording and restore them afterwards. Each `--set` redeploys the service (about 2–3 minutes; calls,
   proofs and scores are kept), so wait until `/demo/status` answers again before you start:
   ```sh
   railway variables --service fermata --set DEMO_PER_IP_SECONDS=5 --set DEMO_PER_IP_PER_DAY=500
   # afterwards:
   railway variables --service fermata --set DEMO_PER_IP_SECONDS=60 --set DEMO_PER_IP_PER_DAY=15
   curl -s https://fermata-production-9378.up.railway.app/demo/status | jq .perIpSeconds   # → 60
   ```
   (On 2026-10-05 the relaxed value, 5, is live: restore it after recording.)
2. **Connect Claude Code to the live gateway** (once; the agent key is `AGENT_PRIVATE_KEY` from your
   local `.env`, a funded testnet key):
   ```sh
   claude mcp add fermata \
     -e FERMATA_GATEWAY=https://fermata-production-9378.up.railway.app \
     -e FERMATA_AGENT_KEY=<AGENT_PRIVATE_KEY from .env> \
     -e TEMPO_RPC_URL=https://rpc.moderato.tempo.xyz \
     -e FERMATA_TRUSTED_VERIFIERS=0xb8718ad26e9ae0058b8b1a369295b374d99af599 \
     -- "$PWD/node_modules/.bin/tsx" "$PWD/apps/mcp/src/index.ts"
   ```
   Do a dry run off camera with the scene's exact prompt, starting Claude Code as
   `claude --allowedTools "mcp__fermata"` so no tool-permission prompt appears on camera (or approve
   each tool once in the dry run). Never call `get_quote` in a dry run: it is the 100-call vendor, and
   one more call changes the 96/100 the Vendors scene shows.
3. **The offline verifier** for the last scene: `(cd apps/attestor && cargo +1.95.0 build --release)`.
4. **Screen:** browser at 1920×1080 (or 1280×720), dark mode, zoom 100 %, no other tabs or
   notifications; terminal font ≥ 16 px. Three windows: the dashboard, a terminal with Claude Code,
   a terminal in the repo.
5. **Never on screen:** `.env`, `.env.railway`, the Railway variables page.

## Storyboard

Lower-third for the whole video: **Tempo Moderato testnet · fermata-production-9378.up.railway.app**.

### 0:00–0:18 · Open (dashboard, Live tab)

**Show:** the dashboard header and tiles; the **Try it** panel. Optional, over the second sentence:
4 s of the README's flow diagram (agent → escrow on Tempo → gateway → TLSNotary → vendor).

> This is Fermata, live on Tempo's testnet. An agent's payment waits in escrow while TLSNotary proves
> what the vendor answered: if it passes the vendor's rule, the vendor is paid; if not, the agent is
> refunded.

### 0:18–0:50 · A delivery is released (Try it → Reliable vendor)

**Show:** click **Reliable vendor**. The note "Holding the price in escrow, proving the vendor's
answer with TLSNotary, settling…" appears, then **✓ Released to the vendor**. Click **Open the
proof**: the vendor's HTTP response, the verdict. Click **Re-verify offline**: every hash ✓. Click the
settle transaction link: the transaction on Tempo's explorer (don't zoom on its Memo field: the
explorer prints the 32-byte memo as raw text; the memo point is made on the Reconciliation tab).

> I press Reliable vendor: held, proved, released. 99.5 percent to the vendor, half a percent fee.
> The proof shows exactly what the vendor's server sent, and Re-verify checks every hash against the
> chain. Here is the payout on Tempo's explorer.

### 0:50–1:12 · Failures are refunded (Broken vendor, Silent vendor)

**Show:** click **Broken vendor** → **↩ Refunded to the agent (proven failure)**; open the proof:
the HTTP 500. Click **Silent vendor**: after its 10 s proving attempt gives up, **⏳ No proof: the
contract refunds the agent once the window closes** · the vendor never answered. Cut; about 35 s after
the click the same call reads **⏱ Refunded (timeout)** in the feed (measured on the live demo:
37 s from click to refund).

> A broken vendor answers HTTP 500: a proven failure, refunded. A silent vendor never answers: no
> proof, no verdict, and after its 30-second window the contract refunds the agent anyway.

### 1:12–1:22 · A real API (Real API: npm registry)

**Show:** click **Real API: npm registry** → **✓ Released to the vendor** · vendor answered HTTP 200.
Open its proof drawer and copy its full **Call id** for the last scene.

> This one is the real npm registry, over the open internet, proved and settled.

### 1:22–1:50 · Claude pays on proof (Claude Code terminal)

**Show:** in Claude Code paste (don't type): *Get the BTC price with get_quote_reliable, then try get_quote_broken, and verify both calls.* Let Claude's answer scroll: one released, one refunded,
both verified. The paid calls take several seconds each on Moderato: speed that stretch up in the edit
(label it "sped up") and keep Claude's summary at normal speed.

> Agents can also pay through MCP tools. I ask Claude for two quotes: the reliable call is released,
> the broken one refunded, and Claude has both proofs re-checked.

### 1:50–2:02 · The books reconcile from the chain (Reconciliation tab)

**Show:** the **Reconciliation** tab: the latest calls, each "✓ matches the outcome", with its
movements.

> Every payment carries the call ID as its memo, so anyone can reconcile each call from chain logs
> alone, without our database.

### 2:02–2:24 · Scores and self-serve listing (Vendors, then List your API)

**Show:** the **Vendors** tab: the top row, **get_quote**, at 96/100 delivered. Then **List your API**:
the URL field already holds `https://registry.npmjs.org/-/package/viem/dist-tags`; click **Check
compatibility**, show the drafted delivery rule (no need to register on camera).

> Verdicts feed a public scoreboard of proven outcomes: this vendor delivered ninety-six of a
> hundred. And a vendor lists its API by pasting a URL: Fermata checks it can be proved and drafts
> the delivery rule.

### 2:24–2:45 · Check it yourself (repo terminal), then the end card

**Show:** `pnpm reverify --call <the npm call's full Call id> --gateway https://fermata-production-9378.up.railway.app`
→ the ✓ lines and **VERIFIED**. End card: the live URL and github.com/bilgin-kocak/fermata.

> You don't have to trust our dashboard: pnpm reverify checks the proof offline against the chain.
> In version one we run the notary and sign the verdicts, so a dishonest verdict is detectable, not
> prevented. Try it at the link below.

## Claims the video may make (and may not)

- ✅ "Anyone can re-verify the evidence offline" (`pnpm reverify`, `fermata-attest verify --offline`).
- ✅ "Refunds by rule: a proven failure, or no proof in time." ✅ "Memo = call ID on every transfer."
- ✅ "Live on Tempo Moderato testnet": the live URL; 100 calls through it → 96/4, 0 errors (2026-10-05).
- ❌ Never "trustless", "decentralized adjudication" or "no trust in us": in v1 our verifier signs the
  verdict and we run the notary. The dashboard's **Re-verify** and Claude's `fermata_verify` both run
  on our gateway; `pnpm reverify` is the check that doesn't.
- ❌ Never "any cheating is detectable": only a verdict that contradicts its proof is (README, note ²).
- ❌ Never "the data is correct": the proof shows what the server sent, not that a price is right.
- ❌ Never latency guarantees: the transcript has no trusted clock.
- ❌ Never that sampled proving, session escrow or vendor-chosen verifiers exist: they are the roadmap.

## Fallback: a local recording

If the live demo is down while you record, run the same story locally and caption it **"local Tempo
emulation"** (never pass it off as testnet):

```sh
PUBLIC=1 bash scripts/demo-stack.sh up --chain anvil   # Try it, Vendors and List your API included
pnpm demo:load --calls 100 --chain anvil               # fills the Vendors tab
open http://127.0.0.1:4300/dashboard
bash scripts/demo-stack.sh down                        # afterwards
```

`node scripts/record/record.mjs` records headless clips of a running stack (see its header; it
needs `playwright-core` and Chromium).

## Pre-record checklist

- [ ] Per-visitor limits relaxed on Railway and the redeploy finished; restored afterwards (`perIpSeconds` → 60).
- [ ] Claude Code connected to the live gateway; the scene's prompt worked in a dry run, with no permission prompt.
- [ ] Every Try it button pressed once off camera. (Silent vendor checked on the live demo on 2026-10-05:
      no proof after its 10 s attempt, **⏱ Refunded (timeout)** 37 s after the click.)
- [ ] `fermata-attest` built locally for `pnpm reverify`.
- [ ] Dark mode, zoom 100 %, no notifications; terminal font ≥ 16 px.
- [ ] No keys on screen (`.env`, `.env.railway`, Railway variables).
- [ ] Numbers spoken match the screen (Vendors tab) and the README.
- [ ] Total ≤ 3:00; captions exported.
