# fermata-attest

The Fermata attestor. It proves a vendor's HTTPS response with TLSNotary (v0.1.0-alpha.15, MPC-TLS
through a separate notary), checks that the presentation belongs to an open on-chain hold, evaluates
the service's delivery predicate and signs the EIP-712 verdict `FermataEscrow.settle` accepts.

```sh
cargo +1.95.0 build --release          # MPC is unusable unoptimised
B=target/release/fermata-attest

# notary (blind: sees commitments, never plaintext)
NOTARY_PRIVATE_KEY=0x… $B notary --listen 127.0.0.1:7047 --ca ../vendor/certs/ca.pem

# hashes a vendor registers on-chain
$B hashes --origin https://vendor.fermata.test:8443 --notary-public-key 0x02… --predicate predicates/quote-v1.json

# prove one call (Authorization/Cookie/Proxy-Authorization values are never revealed)
$B prove --ca ../vendor/certs/ca.pem --resolve vendor.fermata.test:8443=127.0.0.1:8443 \
  --url 'https://vendor.fermata.test:8443/v1/quote?symbol=BTC-USD' -H 'authorization: Bearer …' \
  --call-id 0x… --out call.tlsn

# verify + bind to the chain + sign            # or --offline: no chain, no key, compare hashes
VERIFIER_PRIVATE_KEY=0x… $B verify --presentation call.tlsn --ca ../vendor/certs/ca.pem \
  --call-id 0x… --predicate predicates --rpc http://127.0.0.1:8545 --escrow 0x…

# HTTP API for the gateway: POST /v1/attest | /v1/prove | /v1/verify, GET /v1/presentations/<callId>
VERIFIER_PRIVATE_KEY=0x… $B serve --rpc … --escrow … --ca … --predicate predicates --resolve …

# a real vendor: trust Mozilla's roots (notary, prove, verify, serve all take --roots mozilla);
# behind an egress proxy, tunnel the vendor socket with HTTP CONNECT (never the notary's)
NOTARY_PRIVATE_KEY=0x… $B notary --listen 127.0.0.1:7047 --roots mozilla
FERMATA_UPSTREAM_PROXY=http://127.0.0.1:3128 $B prove --roots mozilla \
  --url https://registry.npmjs.org/-/package/mppx/dist-tags --call-id 0x… --out npm.tlsn
$B verify --offline --presentation npm.tlsn --roots mozilla --predicate predicates/npm-dist-tags-v1.json --call-id 0x… --service-id 0x…
bash ../../scripts/probe-tls.sh api.coinbase.com /v2/prices/BTC-USD/spot   # does a host fit TLSNotary's TLS profile?
```

`--ca` (repeatable) and `--roots mozilla` add up. A proof of a real vendor never verifies against a
dev CA alone, and the reverse holds too. The proxy only relays ciphertext: MPC-TLS runs end to end
with the vendor, and the certificate is checked by the prover, the notary and every verifier. A
proxy that intercepts TLS therefore fails with `UnknownIssuer` and produces no transcript. Hosts
pinned with `--resolve` are always dialled directly.

Before signing, `verify` fails closed unless: the notary key hashes to the service's
`notaryKeyHash`; the TLS server name and `Host` header give the registered `originHash`; only auth
header values are hidden and the revealed request recomputes the hold's `requestHash`; the predicate
hashes to `predicateHash`; the hold is open; the `X-Fermata-Call` header equals the callId; and the
TLS session time lies inside the hold window. No transcript → no verdict (only the on-chain timeout
can then refund).

Tests: `cargo +1.95.0 test --release` (unit) and `cargo +1.95.0 test --release -- --ignored`
(integration with real MPC sessions; needs `node` and `openssl`; writes
`../../contracts/test/fixtures/attest-vector.json`). Measurements in `docs/FACTS.md` §15.2.

TLSNotary plumbing ported from WebProof (github.com/bilgin-kocak/webproof-solana, Apache-2.0) and
the upstream `attestation` example.
