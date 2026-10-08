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

## Keys

Private keys live only in `.env` (git-ignored; `pnpm keys:init` creates testnet keys) and never in
the repository. The Anvil keys in the scripts are Foundry's public development keys. If you find a
real secret committed here, treat it as compromised and tell us.

## Reporting

Please report vulnerabilities privately via GitHub's "Report a vulnerability"
(Security → Advisories) on [bilgin-kocak/fermata](https://github.com/bilgin-kocak/fermata), or to
the maintainer, Bilgin Kocak. We will acknowledge within a few days; there is no bug bounty.
