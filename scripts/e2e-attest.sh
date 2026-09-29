#!/usr/bin/env bash
# Milestone 2 end to end on Anvil's Tempo emulation, every component a real process:
# anvil → FermataEscrow → demo vendors (ok / 500 / hang) → notary → `fermata-attest serve` →
# scripts/attest-e2e.ts (hold, prove, verify, settle, replay, offline re-check, timeout).
#   pnpm attest:e2e:anvil
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
export NO_PROXY="${NO_PROXY:-},vendor.fermata.test,127.0.0.1,localhost"
mkdir -p out
LOGS=out/e2e-attest
mkdir -p "$LOGS"

ANVIL_PORT=${ANVIL_PORT:-8547}
RPC=http://127.0.0.1:$ANVIL_PORT
NOTARY_PORT=7147
ATTESTOR_PORT=7148
OK_PORT=8643
E500_PORT=8644
HANG_PORT=8645
# Dev-only keys (never hold funds): notary signing key and verifier (verdict) key.
NOTARY_KEY=0x2222222222222222222222222222222222222222222222222222222222222222
VERIFIER_KEY=0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b

pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
wait_port() { for _ in $(seq 100); do (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null && return 0; sleep 0.1; done; echo "port $1 did not open" >&2; return 1; }

echo "== build attestor"
(cd apps/attestor && CARGO_NET_GIT_FETCH_WITH_CLI=true cargo +1.95.0 build --release -q)
BIN=$PWD/apps/attestor/target/release/fermata-attest
[ -f apps/vendor/certs/ca.pem ] || bash apps/vendor/gen-certs.sh > "$LOGS/certs.log"
CA=$PWD/apps/vendor/certs/ca.pem

echo "== anvil + escrow"
anvil --chain-id 42431 --port "$ANVIL_PORT" --silent > "$LOGS/anvil.log" 2>&1 & pids+=($!)
wait_port "$ANVIL_PORT"
bash scripts/deploy-escrow.sh --chain anvil --rpc "$RPC" > "$LOGS/deploy.log" 2>&1 || { tail -20 "$LOGS/deploy.log"; exit 1; }
ESCROW=$(jq -r .FermataEscrow.networks.anvil.address packages/sdk/src/deployments.json)
echo "escrow $ESCROW"

echo "== vendors, notary, attestor"
PORT=$OK_PORT node apps/vendor/server.mjs > "$LOGS/vendor-ok.log" 2>&1 & pids+=($!)
PORT=$E500_PORT CHAOS=500 node apps/vendor/server.mjs > "$LOGS/vendor-500.log" 2>&1 & pids+=($!)
PORT=$HANG_PORT CHAOS=hang node apps/vendor/server.mjs > "$LOGS/vendor-hang.log" 2>&1 & pids+=($!)
NOTARY_PRIVATE_KEY=$NOTARY_KEY RUST_LOG=error "$BIN" notary --listen 127.0.0.1:$NOTARY_PORT --ca "$CA" > "$LOGS/notary.json" 2> "$LOGS/notary.log" & pids+=($!)
for p in $OK_PORT $E500_PORT $HANG_PORT $NOTARY_PORT; do wait_port "$p"; done
NOTARY_PUBLIC_KEY=$(jq -r .notaryKey "$LOGS/notary.json")
VERIFIER_PRIVATE_KEY=$VERIFIER_KEY "$BIN" serve --listen 127.0.0.1:$ATTESTOR_PORT --rpc "$RPC" --escrow "$ESCROW" \
  --notary 127.0.0.1:$NOTARY_PORT --ca "$CA" --predicate apps/attestor/predicates --storage out/e2e-attest/presentations \
  --attempt-timeout-secs 10 \
  --resolve vendor.fermata.test:$OK_PORT=127.0.0.1:$OK_PORT \
  --resolve vendor.fermata.test:$E500_PORT=127.0.0.1:$E500_PORT \
  --resolve vendor.fermata.test:$HANG_PORT=127.0.0.1:$HANG_PORT > "$LOGS/attestor.log" 2>&1 & pids+=($!)
wait_port $ATTESTOR_PORT

echo "== run"
ANVIL_RPC_URL=$RPC ATTESTOR_URL=http://127.0.0.1:$ATTESTOR_PORT ATTEST_BIN=$BIN VENDOR_CA=$CA \
  PREDICATE=apps/attestor/predicates/quote-v1.json NOTARY_PUBLIC_KEY=$NOTARY_PUBLIC_KEY \
  VENDOR_OK_PORT=$OK_PORT VENDOR_500_PORT=$E500_PORT VENDOR_HANG_PORT=$HANG_PORT \
  NODE_OPTIONS=--disable-warning=UNDICI-EHPA node_modules/.bin/tsx scripts/attest-e2e.ts
