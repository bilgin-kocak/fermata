# Running a Fermata notary

Fermata pays an API vendor only when a TLSNotary proof shows what the vendor's server sent. A proof
is a transcript the **prover** (Fermata's attestor) and a **notary** produce together over MPC-TLS:
neither holds the whole session key, and the notary signs commitments to the transcript without
seeing it. The proof can be trusted as long as the prover and the notary don't collude.

When Fermata runs both, that assumption is only as good as Fermata's word. This kit lets someone
else run the notary, with **their own key**, so forging a proof would take two operators acting
together.

## What you vouch for, and what you don't

- You run this notary unmodified, built from the commit you deploy.
- You generated the signing key yourself and never give it to the gateway's operator.
- You don't vouch for any API, verdict or payment. The notary is blind: it never sees requests or
  answers, only ciphertext and commitments, plus the server's certificate chain, which it checks
  against Mozilla's roots (and, for the demo's mock vendors only, the demo CA).

## Run it

1. **Make a key and a token** on your machine. Fermata never sees the key.
   ```sh
   openssl rand -hex 32 > notary.key     # signing key: keep it secret, keep it backed up
   openssl rand -hex 24 > notary.token   # access token: you send this to the gateway operator
   ```
2. **Build and start** the container (from the repository root):
   ```sh
   docker build -f deploy/notary/Dockerfile -t fermata-notary .
   docker run -d --name fermata-notary --restart unless-stopped -p 7347:7347 \
     -e NOTARY_PRIVATE_KEY="$(cat notary.key)" -e NOTARY_TOKEN="$(cat notary.token)" \
     -e DEMO_CA_URL=https://<gateway host>/ca.pem \
     fermata-notary
   docker logs fermata-notary | head -1
   # {"notaryKey":"0x02…","notaryKeyHash":"0x…","listen":"0.0.0.0:7347","tokenRequired":true}
   ```
3. **Send the gateway operator** these four things:
   - `host:port`;
   - the `notaryKey` from that first log line (public);
   - the token (over a private channel);
   - the name you want shown, for example `independent: Example Labs`.

   Every service that uses your notary records its key hash on-chain, so anyone can check that a
   proof was signed by your key.

The gateway operator then sets these on the gateway and redeploys:
- `REMOTE_NOTARY_ADDR=host:port`
- `REMOTE_NOTARY_PUBLIC_KEY=0x02…`
- `REMOTE_NOTARY_TOKEN=…`
- `REMOTE_NOTARY_LABEL="independent: Example Labs"`

`scripts/demo-stack.sh` then registers the demo services again, bound to your key, and marks the old
ones legacy.

## Where to run it

- **Close to the gateway.** Each proven call moves about **66 MB** between the prover and the notary
  in many round trips. On the same machine a proof takes about 1 s; across the open internet it can
  take 5–15 s. Run the notary in the same city or cloud region as the gateway (the hosted demo is on
  Railway). Proofs still work from further away, just more slowly.
- **Behind TLS, if you can.** The access token keeps strangers from using your notary, but over plain
  TCP it can be sniffed. A stolen token lets someone use your notary; it does not let anyone forge a
  proof, because that needs your key. A TLS tunnel (stunnel, a TCP proxy with TLS) closes that gap.
- **Resources.** 1–2 vCPU and 1 GB of RAM handle the demo's load: the attestor proves one call at a
  time. Traffic is the cost: about 66 MB per proven call, in both directions.

### On Fly.io (one way to run it)

Any host that can run a container and expose a TCP port works. On Fly.io, a `fly.toml` like this
exposes the port as raw TCP:

```toml
app = "fermata-notary-<you>"
primary_region = "<region near the gateway>"

[build]
  dockerfile = "deploy/notary/Dockerfile"

[[services]]
  internal_port = 7347
  protocol = "tcp"
  [[services.ports]]
    port = 7347
```

```sh
fly launch --no-deploy --copy-config
fly secrets set NOTARY_PRIVATE_KEY="$(cat notary.key)" NOTARY_TOKEN="$(cat notary.token)"
fly deploy
```

This Fly.io setup has not been tested by the project yet; the container itself is the same one the
local end-to-end run uses.

## Checking it

- **Wrong token.** A connection with a wrong or missing token is closed before any MPC work. The log
  line is `notary connection … refused: wrong access token`.
- **Each proof.** `pnpm reverify --call <callId>` (from the repository) checks that the presentation
  is signed by the notary key whose hash the service registered on-chain.
- **Leaving.** To stop being the notary, stop the container. Calls to services bound to your key then
  get no proof and are refunded by timeout. No one can move those services to another notary: a
  service's notary key can't be changed after registration.
