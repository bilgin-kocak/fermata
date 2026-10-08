# Hosting the public demo

This is a public, always-on Fermata on **Tempo Moderato testnet**. Visitors get:
- **Try it** buttons, which make real paid calls through a demo agent;
- the **Vendors** scoreboard;
- **List your API**, self-serve onboarding.

Only the gateway is exposed, behind Caddy with automatic HTTPS. The notary, attestor and mock vendors listen on 127.0.0.1.

## Railway (what the live demo runs on)

The repo's `Dockerfile` builds the whole stack into one container (attestor built in a Rust stage;
dashboard and dev certificates built in the image), and `railway.json` sets the health check (`/info`)
and the restart policy. The container runs `scripts/demo-stack.sh run --chain moderato` in public mode.

```sh
railway init -n fermata                      # new project, linked to this directory
railway add --service fermata
railway domain --service fermata --port 8080 # → https://<name>.up.railway.app
railway volume add --mount-path /data        # calls, proofs, onboarded vendors survive deploys
# keys: a fresh set for the hosted demo (never your laptop's relayer: the two would race for nonces),
# funded with `cast rpc tempo_fundAddress <address>`: VERIFIER_, RELAYER_, VENDOR_, NOTARY_ and
# DEMO_AGENT_PRIVATE_KEY, plus GATEWAY_SECRET_KEY (32 random bytes)
railway variables --service fermata --skip-deploys --set PORT=8080 --set GATEWAY_REALM=<name>.up.railway.app --set …
railway up --ci --service fermata             # upload, build (~5 min), deploy
bash deploy/smoke.sh https://<name>.up.railway.app
```

Behind Railway's edge the visitor's address is the second `X-Forwarded-For` entry from the right (the
edge appends the visitor, then its own hop), hence `GATEWAY_TRUST_PROXY=2` in the image; entries
further left come from the visitor and are ignored, so nobody dodges the per-visitor limits by
sending their own header. Each demo call logs the visitor and the raw headers, to check this.

## A VM instead

## What you need

- **A VM:** Ubuntu 24.04, 4 vCPU / 8 GB, ports 80 and 443 open. Any provider works (Hetzner CX32, DigitalOcean, AWS t3.xlarge…).
- **A host name:** a domain with an A record pointing at the VM, or none at all (`auto` uses `<ip>.sslip.io`).
- **Testnet keys:** your Moderato `.env`. Copying it keeps the escrow and services already registered. Or make fresh keys on the VM with `pnpm keys:init`.

## Three commands

```sh
# 1. install toolchains, clone, build (≈ 10 min the first time: the attestor is Rust)
curl -fsSL https://raw.githubusercontent.com/bilgin-kocak/fermata/main/deploy/install.sh | sudo bash

# 2. keys: either copy your Moderato .env …
sudo install -m 600 -o fermata -g fermata ./.env /opt/fermata/.env
#    … or create fresh testnet keys
sudo -u fermata -H bash -lc 'cd /opt/fermata && pnpm keys:init'

# 3. host name, faucet top-up, HTTPS, start, smoke test
sudo bash /opt/fermata/deploy/bootstrap.sh fermata.example.com     # or: auto
```

`bootstrap.sh` ends by running `deploy/smoke.sh` against the public URL and printing it, for example `https://fermata.example.com/dashboard/`.

## Running it

| | |
|---|---|
| Status, logs | `systemctl status fermata` · `journalctl -u fermata -f` · component logs in `/opt/fermata/out/demo/*.log` |
| Restart | `sudo systemctl restart fermata` (re-registers nothing that exists; keeps state) |
| Update | `sudo bash /opt/fermata/deploy/install.sh && sudo systemctl restart fermata` |
| Is it working? | `bash /opt/fermata/deploy/smoke.sh https://<host>` |
| Testnet funds | `sudo -u fermata -H bash -lc 'cd /opt/fermata && pnpm fund'`; the gateway also tops up the demo agent and relayer itself, and turns the demo read-only rather than failing |
| Recompute the scoreboard | `pnpm scores --chain moderato` (from any machine; reads only the chain) |
| Settings | `/etc/fermata/fermata.env`: limits (`DEMO_PER_IP_SECONDS`, `DEMO_PER_IP_PER_DAY`, `DEMO_DAILY_CAP`), `REAL_VENDORS` |
| State | `/var/lib/fermata/state`: calls, proofs, onboarded vendors (survive restarts) |

## How it fits together

```
internet ──443──▶ Caddy (TLS) ──▶ gateway 127.0.0.1:4300 ──▶ attestor 127.0.0.1:7348 ──▶ notary 127.0.0.1:7347
                                    │  /dashboard /demo/* /onboard/* /scores /mcp /s/:serviceId/*     │
                                    └──── Tempo Moderato RPC ◀──────────────────────────────┘  vendors: 127.0.0.1:884x, registry.npmjs.org
```

- `fermata.service` runs `scripts/demo-stack.sh run --chain moderato`: the same stack as local development, supervised. If any component dies, the whole stack stops and systemd restarts it after 15 s.
- Public mode limits (defaults; the live demo runs with one call per visitor every 5 s, 30 per visitor a day, 500 a day in total):
  - one demo call per visitor every 60 s (`DEMO_PER_IP_SECONDS`) and 15 per visitor a day (`DEMO_PER_IP_PER_DAY`);
  - one call in flight;
  - 500 demo calls a day in total (`DEMO_DAILY_CAP`);
  - onboarding: 20 checks per hour and 3 registrations per day per address, 20 registrations a day in total.
- Onboarding only fetches public HTTPS hosts on port 443. Private, loopback, link-local and metadata addresses are refused.

## If something is wrong

- **The gateway doesn't come up:** `journalctl -u fermata -n 200`. Usually it's a key with no funds (`pnpm fund`), or the Moderato RPC being unreachable.
- **HTTPS fails:** the DNS name must point at the VM and ports 80/443 must be open (`journalctl -u caddy`).
- **The demo says "paused":** the faucet couldn't top up the demo agent or relayer. Run `pnpm fund`, then wait a minute.
- **Fallback without systemd:** `sudo -u fermata -H bash -lc 'cd /opt/fermata && PUBLIC=1 bash scripts/demo-stack.sh up --chain moderato'`, with Caddy as above.

These scripts were tested locally (Anvil, public mode, `run` supervision, `smoke.sh`, shellcheck clean). They first run on a real VM on yours, and `smoke.sh` tells you in a minute whether it works.
