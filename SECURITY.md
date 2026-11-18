# Security

Fermata is **unaudited hackathon code** (Colosseum Crypto World's Fair, Tempo track, 2026). It has
not been reviewed by a third party. Do not use it with real funds.

## Scope

- **Testnet only.** It is built and demonstrated on Tempo Moderato (chain ID 42431) and Anvil's
  Tempo emulation. There is no mainnet deployment and none is planned for the hackathon build.
- **Trust model.** In v1 the escrow trusts one verifier key per service, held by the Fermata
  operator; the notary is a separate process run by us in the demo. A dishonest verdict is
  detectable (every verdict points at a presentation anyone can re-verify offline), not prevented.
  See "What the proof does and does not establish" in the [README](README.md).
- **Proofs are public in the demo.** A presentation reveals the vendor's whole response, and the
  gateway serves it to anyone (`/proofs/:callId`) so that anyone can re-verify; call IDs are public
  on-chain. Do not list an API that returns private or proprietary data on the demo. A production
  deployment needs access-controlled proofs and selective disclosure (see the README section above).
- **Dependencies.** TLSNotary `v0.1.0-alpha.15` is alpha software consumed as a git dependency;
  `mppx@0.11.0` is an early release.

## Hardening (2026-11)

A code review after the hackathon found, and this repository fixed, these issues in the gateway and
SDK (regression tests in `apps/gateway/test` and `packages/sdk/test`):

- **A free answer near the deadline.** A credential presented just before the hold's window closed
  was served, the settlement missed the window, and the agent reclaimed the hold by timeout. The
  server now needs `minRemainingSeconds` (15 s, at most a third of the window) left.
- **A verdict lost on restart.** A signed verdict is stored as `settle-pending` in the same write, so
  the sweeper settles it after a crash instead of refunding a call the vendor delivered.
- **RPC lag read as final.** An escrow status of "none" (a node behind) is retried, never closed.
- **Proofs never settled after an attestor failure.** The sweeper asks the attestor to verify the
  stored presentation again inside the window; settle and claim receipts time out after 20 s so one
  stuck transaction does not hold every settle past its window; onboarding registrations from the
  relayer key share its write queue.
- **Replay after a restart.** A credential whose call already has a record is refused (409).
- **Unprovable requests.** Bodies that are not UTF-8, or requests over 2048 bytes, get 413/415 before
  any challenge, so no one pays for a call that can only time out.
- **Public-demo abuse.** The demo agent pays onboarded services only up to 0.01 (anyone can list one
  at up to 1.00 with their own payout); body-size limits; per-visitor rate limits on paid routes and
  proof re-verification.
- **An open notary port.** The notary served MPC sessions to anyone who could reach it. It now
  refuses a connection that does not open with its access token, before any MPC work. Each service
  can name its own notary, so the notary can run on another operator's machine (`deploy/notary/`).
  A notary outage or a TLSNotary setup stall is reported as the gateway side's failure (503), never as
  the vendor not answering, and a setup stall gets one more attempt, since the vendor was not
  contacted.
- **Rate limits shared by everyone using MCP.** In-process requests (the MCP endpoint's
  `fermata_verify`, the demo agent) had no client address, so every MCP user shared one bucket of
  proof re-verifications. They are now limited where they enter (`/mcp`, `/demo/call`).
- **Listings were not ownership-checked.** Anyone could list any public API under their own payout.
  A lister can now prove control of the API's host for that exact payout (a DNS TXT record at
  `_fermata.<host>` or `/.well-known/fermata.json`). The gateway checks it at registration and daily,
  and the listing is labelled "owner verified" or "owner not verified" wherever it appears.
  `ONBOARD_REQUIRE_OWNER_PROOF=1` refuses unverified listings.
- **Score gaming with bad requests.** A proven 4xx (the agent's own bad input) is a client error:
  refunded, shown, never counted against the vendor. Each failure is classified by the HTTP status
  its public proof shows (`pnpm scores --proofs` recomputes it). A vendor that hangs instead of
  failing is shown with a no-answer rate (the gateway's own records; a hang leaves nothing to prove).

Known and not yet fixed:

- **Front-running a call ID.** `hold` keys records by `callId` alone: someone who sees an agent's
  pending hold can hold the same `callId` first (against a service of their own), and the agent's
  transaction reverts. The agent loses gas, not funds. Fixing it changes the contract interface.
- **Score limits.** The no-answer rate rests on the gateway's records, not on proofs, and counts the
  gateway's own network failures as no-answer. An API that reports bad input as HTTP 200 with an error
  body (Kraken does) turns an agent's bad input into a vendor failure: such services should take no
  agent input (the demo's Kraken tool uses a fixed pair). A vendor can still pay itself to inflate its
  score; distinct agents are shown for that reason.
- **What an ownership proof shows.** Control of the host's DNS or web root when it was checked,
  re-checked daily: not who wrote the API. Unverified listings are allowed unless the gateway requires
  a proof; agents see the label in the MCP tool description.
- **Who runs the notary is a claim.** The scoreboard's "notary: …" name comes from the gateway's
  configuration. What anyone can check is the notary key hash registered on-chain for each service,
  and that every proof is signed by that key. While Fermata runs the notary, Fermata alone could
  produce a proof of bytes a server never sent.
- **Unrecoverable refunds.** A refund to an agent that a TIP-20 issuer has blacklisted reverts.

## Keys

Private keys live only in `.env` (git-ignored; `pnpm keys:init` creates testnet keys) and never in
the repository. The Anvil keys in the scripts are Foundry's public development keys. If you find a
real secret committed here, treat it as compromised and tell us.

## Reporting

Please report vulnerabilities privately via GitHub's "Report a vulnerability"
(Security → Advisories) on [bilgin-kocak/fermata](https://github.com/bilgin-kocak/fermata), or to
the maintainer, Bilgin Kocak. We will acknowledge within a few days; there is no bug bounty.
