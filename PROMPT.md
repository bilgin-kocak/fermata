# Fermata — build prompt for Claude Code / Codex

Paste everything below this line as the first message of a fresh Claude Code or Codex session, from inside an empty git repo called `fermata`. Or save this file as `PROMPT.md` in that repo and say: "Read PROMPT.md and start with Milestone 0."

## Who you are and what you are building

You are a senior full-stack crypto engineer working with me (Bilgin) on Fermata, a hackathon submission for the Tempo track of Colosseum's Crypto World's Fair (submission deadline October 12, 2026). We have about three weeks. You ship working code, commit often, and stop to ask me when a decision is mine to make.

**Fermata in one sentence:** Fermata holds an agent's Tempo payment for an API call until an independently verifiable record of the vendor's HTTPS response (a TLSNotary presentation) passes a pre-agreed, mechanically checkable delivery predicate. A verified failure, or an expired proof window, returns the payment to the agent. In v1 a disclosed Fermata verifier signs the on-chain settlement decision; anyone can re-verify the evidence it decided on.

**Pitch line:** "Chargebacks for machine payments, decided on cryptographic evidence instead of a support ticket."

**Tagline:** "Pay on proof."

**What makes this different from x402/MPP receipts:** receipts prove the buyer paid. Fermata proves what the seller delivered, holds the money until that check passes, and refunds by rule when it doesn't. Say this explicitly in the README and the video.

**What the proof does and does not establish** (write this into the README verbatim, adjusted for what you verify in Milestone 0)

* A TLSNotary presentation establishes that a specific HTTPS server, identified by its TLS certificate, sent specific bytes in response to specific request bytes. That is all. It does not establish that the data is correct (a quoted price can be wrong), and it cannot establish that a server never responded (no transcript, no proof).
* Therefore the delivery predicate only contains things that are checkable on the transcript: status code, content type, body size, JSON shape. No latency or timing checks in the predicate — the transcript has no trusted clock. Latency SLAs, if any, are gateway policy, not proof-backed.
* No response from the vendor → no transcript → no verdict. The agent is protected by the on-chain timeout refund, never by a verdict signed without evidence.
* Trust model in v1: the escrow contract trusts one registered verifier key per service, which Fermata holds; the notary is a separate process (run by us in the demo, pluggable to a third-party notary such as PSE's if it is up) whose only job is to be blind; the gateway is the prover. A vendor therefore trusts the Fermata operator to sign honest verdicts, including refunds. What the design adds over "trust the operator": every verdict points at a presentation anyone can download and re-verify offline against the pinned notary key, so a dishonest verdict is detectable and the evidence is portable to any future adjudicator. Independent verification is not the same as independent adjudication; roadmap items (vendor-chosen verifiers, N-of-M verifier quorum, on-chain presentation verification) close that gap. Never claim more than this anywhere in the repo or the pitch.

**Why the name:** a fermata is the musical symbol (𝄐) that holds a note; Tempo is a music-named chain; we hold the payment until the proof lands. Use the 𝄐 symbol in the logo and the vocabulary `hold → release(proof) → refund` throughout the code and docs.

**Definition of done** (acceptance test for the whole project): three canonical cases, each run end to end on Tempo testnet from one command, each with explorer links and a downloadable, offline-re-verifiable proof:

1. Verified delivery → release. Vendor returns a valid response; the presentation passes the predicate; the vendor is paid, minus fee, with the call's memo.
2. Verified failure → refund. Vendor returns an authenticated HTTP 500 or malformed JSON; the presentation exists and fails the predicate; the agent is refunded with the call's memo.
3. No proof before deadline → timeout refund. Vendor never responds (or the notary is down); no verdict is ever signed; after the settlement window the agent reclaims the hold.

**The video centerpiece** (a reliability test on top of the above, not the definition of done): an agent buys 100 API calls through Fermata with the vendor configured to fail ~3%. Roughly 97 release, roughly 3 refund, every one settled on-chain with a memo pointing at the call, and no human touches anything, shown live on a dashboard. If per-call proving makes 100 calls too slow for a 3-minute video, run it ahead of time and show the recorded run plus a live single call; tell me the numbers.

## Ground truth you must not hallucinate around

Read these before writing code. If a real API differs from what I state here, the docs win — update `docs/FACTS.md` and tell me.

### Tempo (the chain)

* Tempo is a payments-first, EVM-compatible L1 incubated by Stripe and Paradigm. Fees are paid in USD stablecoins, not a native gas token. Deterministic finality in well under a second.
* Testnet: "Moderato", chain ID `42431`, public RPC `https://rpc.moderato.tempo.xyz`, explorer `https://explore.tempo.xyz`. We build and demo on testnet. Do not touch mainnet.
* Transaction fees are deducted from the sender's stablecoin balance separately from the transfer amount (a `transferWithMemo` of 1.00 delivers exactly 1.00). Every wallet that sends transactions — the agent, the gateway's relayer, the vendor's registration key — therefore needs a pathUSD balance. Check the docs for how the fee token is selected per account and let `viem/tempo` handle the default; record what you find in `FACTS.md`.
* Faucet: the RPC method `tempo_fundAddress` on the public RPC funds an address with 1M of each testnet stablecoin. The Tempo CLI also does it: `curl -fsSL https://tempo.xyz/install | bash`, then `tempo wallet login`, `tempo wallet fund`.
* TIP-20 is Tempo's token standard (ERC-20 plus memos, transfer policies, 6 decimals, EIP-2612 permit). Key functions: `transferWithMemo(address to, uint256 amount, bytes32 memo)`, `transferFromWithMemo(...)`, `permit(...)`. Event: `TransferWithMemo(address indexed from, address indexed to, uint256 value, bytes32 indexed memo)`. The memo is a fixed 32 bytes; longer data must be hashed.
* Testnet stablecoins (all 6 decimals, same addresses on testnet and mainnet): `pathUSD 0x20c0000000000000000000000000000000000000`, `AlphaUSD 0x20c0000000000000000000000000000000000001`, `BetaUSD 0x20c0000000000000000000000000000000000002`, `ThetaUSD 0x20c0000000000000000000000000000000000003`. Use pathUSD as the default currency.
* TypeScript SDK: viem has first-party Tempo support. `import { Actions, Abis } from 'viem/tempo'`. Example: `Actions.token.transferSync(walletClient, { token, to, amount: parseUnits('1', 6), memo: toHex('CALL-123', { size: 32 }) })`. `Abis.tip20` is the TIP-20 ABI. There is also a Go SDK and the `tempo` CLI.
* Docs: `https://tempo.xyz/developers` (and `https://docs.tempo.xyz/...` redirects there). Read specifically: `guide/payments/send-a-payment`, `guide/payments/transfer-memos`, `protocol/tip20/spec`, and the CLI page. Chainstack has a good end-to-end tutorial: `https://docs.chainstack.com/docs/tempo-tutorial-first-payment-app`.

### MPP (Machine Payments Protocol)

* Open standard co-authored by Stripe and Tempo. Spec: `https://mpp.dev` and `https://github.com/tempoxyz/mpp-specs`. Flow: client requests a resource → server answers `402 Payment Required` with a `WWW-Authenticate: Payment ...` challenge → client pays via the named method → client retries with `Authorization: Payment ...` credential → server verifies and returns the resource plus a receipt. Intents include `charge` (one-shot); the spec also defines others (session/authorize/subscription style) — read the spec and record the exact list in `FACTS.md`. Methods: `tempo`, `stripe`, others. Methods are extensible — we will add a `fermata` method.
* TypeScript SDK: `npm i mppx` (canonical repo `https://github.com/wevm/mppx`). Server:

```ts
import { Mppx, tempo } from 'mppx/server'
const mppx = Mppx.create({
  methods: [tempo({ currency: '0x20c0000000000000000000000000000000000000', recipient: '0x...' })],
  secretKey: process.env.MPP_SECRET_KEY!, // >= 32 bytes
})
const response = await mppx.charge({ amount: '0.01' })(request)
if (response.status === 402) return response.challenge
return response.withReceipt(Response.json({ ... }))
```

Client:

```ts
import { Mppx, tempo } from 'mppx/client'
Mppx.create({ methods: [tempo({ account: privateKeyToAccount('0x...') })] }) // patches fetch to auto-pay 402s
```

Validator: `npx mppx@latest validate http://localhost:4242` exercises discovery, challenge format, error handling and the full pay flow. Our gateway must pass it for the plain `tempo` method and should pass it for the `fermata` method (report what fails if the validator does not understand custom methods).

* Stripe's MPP quickstart (`https://docs.stripe.com/payments/machine/mpp/quickstart`) shows the same `mppx` API and confirms `stripe.create(...)` auto-configures Tempo testnet in sandbox mode. We do not need Stripe for the hackathon build; keep a `stripe` method behind a flag as a roadmap item only.

### TLSNotary

* Rust implementation: `https://github.com/tlsnotary/tlsn`. Docs: `https://tlsnotary.org/docs/intro` (if the docs host is down, use the repo README and `crates/examples`). Use a tagged release, not `main` — the project warns of breaking changes. Roles: Prover (makes the TLS request, gets a commitment), Notary (blind attestor that signs the commitment), Verifier (checks a presentation and gets the selectively revealed transcript). The flow in examples is `attestation/prove → present → verify`.
* Known constraints to design around: MPC cost grows with transcript size, so keep proven responses small (a few KB); check the release notes for which TLS versions (1.2 vs 1.3) and HTTP versions the current release supports and make the demo vendor server compatible; there may be a public notary run by PSE (`notary.pse.dev`) but run a local notary server in dev and in the demo so nothing external can break us.
* I already have a TLSNotary project called WebProof (TLSNotary verification, originally for Solana). Ask me for the repo path or link on Milestone 0; reuse its prover/verifier plumbing before writing new code.

## Architecture (v1 — what we ship for the hackathon)

Five parties, two of which are ours.

1. Agent (buyer): any MPP-capable client. Adds one line: `fermata({ account })` to its `mppx` client methods.
2. Vendor (seller): any HTTPS API. In v1 the vendor does nothing except register a service on the Fermata contract and point Fermata at its upstream URL. (Roadmap: vendor runs the gateway itself.)
3. Fermata Gateway (ours, TypeScript): the MPP server the agent talks to. Issues 402 challenges for the `fermata` method, verifies the escrow hold, forwards the request upstream through the TLSNotary prover, and hands the resulting presentation to the verifier.
4. Fermata Attestor (ours, Rust): one binary with two subcommands. `prove`: makes the upstream HTTPS request through TLSNotary and produces an attestation + presentation revealing the request line, the response status line and the response body (or selected byte ranges). `verify`: checks a presentation, evaluates the service's delivery predicate, and signs an EIP-712 verdict. Ships with a local notary server in `docker-compose`.
5. FermataEscrow (ours, Solidity on Tempo testnet): holds funds per call, releases on a signed `DELIVERED` verdict, refunds on `FAILED`, refunds on timeout if no verdict arrives.

### Contract design — `contracts/src/FermataEscrow.sol`

* `registerService(bytes32 serviceId, address payoutAddress, address token, uint256 pricePerCall, uint32 settlementWindow, address verifier, bytes32 predicateHash, bytes32 originHash, bytes32 notaryKeyHash)` — vendor-owned record. `predicateHash` is the hash of the JSON predicate the attestor enforces (see below); `originHash` is the hash of the exact upstream origin (`https://host:port`) the proof must be against; `notaryKeyHash` pins the notary public key(s) accepted for this service. All three are committed on-chain so the rules of the game cannot change under an open hold.
* `hold(bytes32 callId, bytes32 serviceId, bytes32 requestHash, uint256 deadline, uint8 v, bytes32 r, bytes32 s)` — pulls `pricePerCall` from the agent with `transferFromWithMemo` after an EIP-2612 `permit`, so the hold is one transaction and the on-chain memo of the transfer is `callId`. `requestHash = sha256(serviceId ‖ method ‖ path-with-query ‖ sha256(canonical body))`. Emits `Held(callId, serviceId, agent, amount, requestHash)`.
* `settle(bytes32 callId, Verdict calldata v, bytes calldata sig)` — anyone can submit. Verifies the EIP-712 signature against the service's registered verifier and checks `v.serviceId`, `v.requestHash`, `v.predicateHash` equal the stored values for this hold. `DELIVERED` → `transferWithMemo(payout, amount − fee, callId)` + fee to treasury. `FAILED` → `transferWithMemo(agent, amount, callId)`. One settlement per `callId`, ever. Emits `Released` or `Refunded` with the `presentationHash` from the verdict.
* `claimTimeout(bytes32 callId)` — if `block.timestamp > heldAt + settlementWindow` and no verdict, refund the agent. This is the agent's protection against a dead vendor, a dead notary, or a dead Fermata. This is the only path for "no response"; the verifier never signs a verdict without a transcript.
* Verdict struct: `{ bytes32 callId; bytes32 serviceId; bytes32 requestHash; bytes32 predicateHash; uint8 outcome; bytes32 presentationHash; bytes32 responseHash; uint64 issuedAt; }`. EIP-712 domain: name `Fermata`, version `1`, chainId `42431`, `verifyingContract` = the escrow address (so a verdict cannot be replayed against another deployment).

**Proof-to-purchase binding** (the verifier MUST check all of these before signing anything)

A valid presentation for the wrong request must never unlock a payout. Before evaluating the predicate, `fermata-attest verify` checks, and fails closed on any mismatch:

1. The presentation verifies under a notary key whose hash equals the service's registered `notaryKeyHash`.
2. The server name / certificate in the presentation matches the registered origin (`originHash`).
3. The revealed request line and headers show the exact method and path-with-query, and the revealed (or committed) body hash equals the body hash, such that recomputing `requestHash` yields the value in the on-chain `Held` event for this `callId`.
4. The predicate being evaluated hashes to the service's registered `predicateHash`.
5. The `callId` has an open hold on-chain (no verdict yet, deadline not passed). Only then is the predicate evaluated and the verdict signed. Write a negative test for each of the five.

* Fee: `feeBps` (default 50 = 0.5%), only charged on release, never on refund. Owner-settable with a cap.
* Every token movement uses the `WithMemo` variant with `callId` as the memo. This is the Tempo-native detail: an accountant can reconcile every hold/release/refund from `TransferWithMemo` logs without our indexer. The dashboard should demonstrate this by querying logs by memo.
* No upgradeability, no proxies. Small, readable, fully unit-tested in Foundry. Custom errors, no strings.

### Delivery predicate (what "the API returned what it promised" means)

A small JSON document the vendor commits to at registration. v1 supports exactly these checks, evaluated by the attestor over the revealed transcript:

```json
{
  "version": 1,
  "status": [200],
  "maxBodyBytes": 4096,
  "contentType": "application/json",
  "jsonSchema": { "type": "object", "required": ["price", "timestamp"] }
}
```

Every field is checkable on the transcript alone. No timing fields (see "What the proof does and does not establish"). `jsonSchema` is a subset (type / required / properties with type) — do not pull in a full validator unless it is tiny. `presentationHash` in the verdict is the hash of the TLSNotary presentation bytes; the gateway stores the presentation at `storage/presentations/<callId>.tlsn` and serves it at `GET /proofs/:callId` so either party can re-verify independently with `fermata-attest verify --offline`.

### The `fermata` MPP method

Implement as a method plugin for `mppx`, mirroring how the built-in `tempo` method is structured (read its source in `wevm/mppx` first). Challenge carries: escrow contract address, `serviceId`, `callId` (server-generated, unique), `requestHash` (as defined above), `amount`, `currency`, `deadline`. Credential carries: the `hold` transaction hash. Server-side verification: fetch the receipt, confirm a `Held` event with matching `callId`/`requestHash`/`amount`, then forward the request. If a custom method is impossible inside `mppx` without forking, fork it into `packages/mppx-fermata` and tell me; do not silently downgrade to "agent pays vendor directly".

Fallback for clients that don't know `fermata`: an MPP challenge can list several methods and the client picks one it supports. The gateway offers both `fermata` (escrowed, protected) and plain `tempo` (direct pay to the vendor, unprotected) in every challenge, so a vanilla `mppx` client still works. Calls paid via plain `tempo` are proxied without escrow and tagged `unprotected` in the receipt and the dashboard. This turns "not every client supports our method" from a caveat into a visible upsell.

### Repository layout (pnpm monorepo + Foundry + Cargo)

```
fermata/
  README.md                    # pitch, architecture diagram, quickstart, demo script
  PROMPT.md                    # this file
  docs/FACTS.md                # verified facts about Tempo / MPP / TLSNotary with source URLs and dates
  docs/PLAN.md                 # your milestone plan, updated as you go
  docs/DEMO.md                 # the exact click-by-click demo script for the video
  contracts/                   # Foundry: FermataEscrow.sol, tests, deploy script, ABI export
  packages/sdk/                # TS: fermata() client + server method for mppx, contract bindings
  apps/gateway/                # TS (Hono on Node): MPP server, proxy, proof storage, settlement submitter
  apps/attestor/               # Rust: `fermata-attest prove|verify|serve`, TLSNotary prover/verifier, EIP-712 signer
  apps/dashboard/              # Vite + React: live view of holds/releases/refunds, proof viewer, memo reconciliation
  apps/demo-vendor/            # TS: tiny HTTPS JSON API with a CHAOS_RATE env var (default 0.03)
  apps/demo-agent/             # TS: loop that buys N calls via the fermata client and prints a summary
  docker-compose.yml           # notary server + demo vendor (TLS via mkcert) + gateway + attestor
  .env.example
```

Conventions: TypeScript strict, ESM, `viem` (not ethers), Hono for HTTP, Vitest for TS tests, Foundry for Solidity, `cargo clippy -D warnings` for Rust. One `pnpm dev` brings the whole thing up. Conventional commits. Never commit private keys; `.env.example` lists every variable with a comment.

## Milestones (do them in order; each ends with green tests, a commit, and a short report to me)

### Milestone 0 — Facts and plan (half a day)

1. Fetch and read every doc URL in the "Ground truth" section. Write `docs/FACTS.md`: for each fact, the value, the source URL, and the date you checked. Flag anything that contradicts this prompt.
2. Clone `tlsnotary/tlsn` at the latest tagged release, build the `attestation` examples and the notary server, and record exact crate versions and any TLS/HTTP constraints in `FACTS.md`.
3. Read the `tempo` method source in `wevm/mppx` and note how to add a custom method.
4. Ask me for the WebProof repo. Skim it and list what is reusable.
5. Write `docs/PLAN.md` with your revised estimate per milestone. Stop and show me FACTS.md and PLAN.md before writing product code.

### Milestone S — Integration spike, the go/no-go gate (1–1.5 days, before any product code)

Three throwaway probes in `spikes/`, each a single script with a README line saying what it proved and how long it took. None of this is production code; it exists to find out where the design breaks before we build on it.

1. Proof path: one TLS-notarized request from a local prover through a local notary to a local TLS server (the future demo vendor, `mkcert` cert) → a presentation → an offline verification that prints the revealed request line, status and body → a hand-rolled predicate check → an EIP-712 verdict signature → a minimal Foundry contract on Moderato (`settle` only, one verifier key) that accepts it. Record prove-time, presentation size, and any TLS/HTTP constraint you hit.
2. Custom MPP method: a 30-line `mppx` server offering a challenge with a made-up method next to the built-in `tempo` method, and a client that (a) with the plugin pays via the custom method, (b) without the plugin falls back to `tempo`. If `mppx` cannot do this without a fork, say so now.
3. TIP-20 on Moderato: a probe that funds two fresh wallets from the faucet, signs a `permit`, executes `transferFromWithMemo` from a contract, and reads the memo back from the `TransferWithMemo` log. Confirm how fees are charged and whether a fee token must be set.

Gate: all three green → proceed to Milestone 1 with the architecture as written. Any red → stop, report, and we redesign that piece together before continuing. Do not build around a red probe on your own.

### Milestone 1 — Escrow contract on Tempo testnet (2 days)

* `FermataEscrow.sol` as specified, with Foundry tests covering: register, hold via permit, settle DELIVERED with fee, settle FAILED, wrong verifier signature reverts, verdict with mismatched `serviceId`/`requestHash`/`predicateHash` reverts, verdict signed for another contract address reverts, replayed verdict reverts, timeout refund, timeout before window reverts, memo equals `callId` on every transfer (assert on `TransferWithMemo` logs using a TIP-20 mock that emits them).
* Deploy script for Moderato using a funded faucet wallet; write the address and ABI to `packages/sdk/src/deployments.json`.
* Acceptance: `forge test` green; a deployed contract on `explore.tempo.xyz` with one real `hold → settle` round-trip executed from a script, links in the report.

### Milestone 2 — Attestor (3–4 days, the hard part)

* `fermata-attest prove --url <upstream> --method POST --body @req.json --notary <ws://...> --out <callId>.tlsn`: runs the TLSNotary prover against the upstream, reveals request line + response status + body, writes the presentation.
* `fermata-attest verify --presentation <file> --predicate <json> --signer <key>`: verifies the presentation (notary key pinned from config), evaluates the predicate, prints the verdict JSON and its EIP-712 signature. `--offline` mode for third parties re-checking a proof.
* `fermata-attest serve`: exposes both over a small HTTP API for the gateway.
* Acceptance: a Rust integration test that proves a request against the demo vendor over local TLS, verifies it, and produces a verdict whose signature `FermataEscrow.settle` accepts in a Foundry test (export the fixture). Measure and record prove-time per call in `FACTS.md`; if it is over ~10 s, tell me before optimizing.

### Milestone 3 — Gateway + `fermata` method + SDK (3 days)

* Gateway routes: `ANY /s/:serviceId/*` (the paid proxy), `GET /proofs/:callId`, `GET /calls/:callId`, `GET /services`.
* Flow per call: 402 challenge → verify `Held` → prove upstream via attestor → verify → submit `settle` from the gateway's relayer wallet → return the upstream response plus an MPP receipt with `callId`, `txHash`, `presentationHash`, `outcome`.
* Failure handling, exactly two branches: (a) a transcript exists (vendor answered, even with a 500 or garbage) → verify, run the binding checks and the predicate → `DELIVERED` or `FAILED` verdict → settle. (b) No transcript (vendor never answered, TLS failed, notary down, prover crashed) → no verdict, no settlement, log loudly, surface the call as `awaiting-timeout` in the dashboard; the on-chain timeout refund is the only exit. Never sign a verdict without a presentation behind it.
* `packages/sdk`: `fermata()` client method for `mppx/client`; `fermataMethod()` server method for `mppx/server`; typed contract bindings; a `reconcile(token, memo)` helper that pulls `TransferWithMemo` logs by `callId`.
* Acceptance: `npx mppx@latest validate` passes for the plain `tempo` method on the gateway; an end-to-end Vitest test runs one paid call through the whole stack on Moderato; report what the validator says about the `fermata` method.

### Milestone 4 — Demo vendor, demo agent, dashboard (3 days)

* Demo vendor: `/v1/quote?symbol=...` returns `{ price, timestamp, source }`; `CHAOS_RATE` makes it return 500 or truncated JSON; served over TLS in a way TLSNotary can prove (check the constraint you recorded in Milestone 0).
* Demo agent: `pnpm demo:agent --calls 100` buys 100 quotes with the `fermata` client, prints a table (callId, outcome, txHash) and totals: held / released / refunded / fee paid / wall-clock time.
* Dashboard: live feed of `Held/Released/Refunded` from the contract, per-call drawer with the proof (revealed transcript rendered, notary key, verdict signature, "re-verify" button that calls `/proofs/:callId` and runs the offline verifier via the attestor), and a Reconciliation tab that queries the token's `TransferWithMemo` logs by memo and matches them to calls — the Tempo-native selling point. Light and dark mode, works on a phone, 𝄐 in the header.
* Acceptance: `pnpm demo:cases` runs the three canonical cases (release / verified-failure refund / timeout refund) end to end on Moderato and prints a pass/fail table with explorer links — this is the definition of done. Then `pnpm demo:load --calls 100` runs the 100-call reliability test with the outcome ≈97/3 and every row linking to `explore.tempo.xyz`; record wall-clock time, per-call prove time, and bandwidth in `docs/FACTS.md`.
* Economics note for the README (judges will ask): per-call MPC proving is too slow and too bandwidth-heavy for one-cent calls at scale. v1 proves every call to demonstrate the mechanism. The roadmap section must describe the production shape honestly: session escrow (hold once for N calls, settle in batches), sampled proving (prove a random, unpredictable subset; the vendor doesn't know which calls are checked), and prove-on-dispute (proofs only when the agent flags a call, with the hold covering the dispute window). Give the measured numbers from the load test as the reason.

### Milestone 5 — Submission polish (2 days)

* README with: pitch line, the chargeback framing, the one-paragraph "different from receipts" statement, architecture diagram (Mermaid), the "What the proof does and does not establish" section verbatim, the v1 trust model verbatim, the economics note, roadmap (vendor-chosen verifiers and N-of-M quorum, on-chain presentation verification, vendor-hosted gateways, session escrow / sampled proving / prove-on-dispute, `session` intent for streaming APIs, Stripe method for fiat vendors), and the exact quickstart.
* Freeze rule: the demo, video and README are frozen at least 72 hours before the October 12 deadline. After the freeze, only bug fixes that a failing `pnpm demo:cases` justifies. If I am travelling in the last days before the deadline, the freeze moves earlier; I'll tell you the date.
* `docs/DEMO.md`: a 2–3 minute video storyboard: 15 s problem (agents pay blind, no recourse), 20 s what Fermata is, 90 s the 100-call run with the dashboard, 20 s reconciliation by memo, 15 s roadmap and ask.
* Colosseum submission checklist: product name and description, Tempo integration details, team, location, logo (𝄐), GitHub link, video, 3-minute demo, go-to-market (first customers: API vendors already selling to agents via MPP/x402; wedge: they get chargeback-grade trust without building it).
* A `SECURITY.md` that says plainly this is unaudited hackathon code.

## Rules of engagement

* Testnet only. Keys come from `.env`; the faucet funds them; never ask me for real funds.
* Do not invent APIs. When unsure, fetch the doc, or write a 10-line probe script and run it against Moderato.
* Prefer the smallest thing that makes the demo real over the general thing. If a milestone is slipping, cut scope from the dashboard first, the SDK second, never from the contract or the proof path.
* Ask me before: changing the contract interface, choosing a different proof approach, adding a dependency over 1 MB to the attestor, or spending more than half a day on any single bug.
* After each milestone, give me: what works, what is faked (if anything), commands to reproduce, and open risks. Keep it under 200 words.
* Language: code, comments and docs in English. I will handle the Turkish material myself.

Start with Milestone 0.
