# Demo CAs of earlier hosted builds

The hosted demo's mock vendors (`vendor.fermata.test`) present certificates from a demo CA. A proof of
a mock vendor re-verifies offline only against the CA in use when it was made. Until 2026-11-18 the
image made a new CA at every build, so each rebuild left the older proofs without their CA.

These are the certificates (public, no keys) of the CAs those builds used, as far as they could be
recovered. A hosted stack (`FERMATA_STATE_DIR` set) adds them to the trust bundle it gives the notary
and the attestor and serves at `/ca.pem`; since 2026-11-18 its own CA lives on the volume and survives
rebuilds ([`deploy/README.md`](../README.md)).

| File | Build (Railway deployment) | Proofs | Recovered from |
|---|---|---|---|
| `2026-10-05-D6A2D4C97DA6F819.pem` | `6096ba69` (and its redeploy `4cc05a95`): the 100-call run | 105 | the image, redeployed; `ca.pem` read in the container (no `/ca.pem` yet) |
| `2026-10-05-7D5CE43EC497C0F4.pem` | `bfcef93a` | 5 | the image, redeployed; its `/ca.pem` |
| `2026-10-06-FD08315AFE06A2DC.pem` | `b9e1e2a6` (and its redeploy `d7279a6c`) | 29 | the image, redeployed; its `/ca.pem` |
| `2026-10-08-DCE7F45ABB606C22.pem` | `4f989686` | 10 | a rollback to it; its `/ca.pem` |
| `2026-11-18-DFB47E6F6827C375.pem` | `8dd4f4e5` | 2 | its `/ca.pem`, saved while it ran |

Not recovered: the CAs of three short-lived builds of 2026-10-05 (`862b0d10`, `f8dd3f46`, `7798e4a9`),
6 mock-vendor proofs in all. Those builds predate `/ca.pem`. Their on-chain records (hold, verdict,
presentation hash) are intact; only the offline check of the server certificate can't run.

A file's name ends with the first 16 hex digits of the certificate's SHA-256 fingerprint:
`openssl x509 -noout -fingerprint -sha256 -in <file>`.
