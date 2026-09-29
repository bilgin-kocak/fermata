#!/usr/bin/env bash
# Milestone 3 end to end on Anvil's Tempo emulation, every component a real process:
# anvil → FermataEscrow → vendors (ok / 500 / hang) → notary → attestor serve → services registered →
# gateway → Vitest e2e (an mppx agent paying with `fermata`).
#   pnpm gateway:e2e:anvil
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
export NO_PROXY="${NO_PROXY:-},vendor.fermata.test,127.0.0.1,localhost"
LOGS=out/e2e-gateway
rm -rf "$LOGS" && mkdir -p "$LOGS"

ANVIL_PORT=${ANVIL_PORT:-8548}
RPC=http://127.0.0.1:$ANVIL_PORT
NOTARY_PORT=7247
ATTESTOR_PORT=7248
GATEWAY_PORT=4300
OK_PORT=8743
E500_PORT=8744
HANG_PORT=8745
# Dev-only keys (Anvil): notary, verifier, relayer = anvil dev account 4, funder = dev account 0.
NOTARY_KEY=0x2222222222222222222222222222222222222222222222222222222222222222
VERIFIER_KEY=0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b
RELAYER_KEY=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
FUNDER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
TSX="node_modules/.bin/tsx"
export NODE_OPTIONS=--disable-warning=UNDICI-EHPA

pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
wait_port() { for _ in $(seq 150); do (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null && return 0; sleep 0.1; done; echo "port $1 did not open" >&2; return 1; }

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
git checkout -q packages/sdk/src/deployments.json 2>/dev/null || true # keep the committed anvil entry stable
echo "escrow $ESCROW"

echo "== vendors, notary, attestor"
PORT=$OK_PORT node apps/vendor/server.mjs > "$LOGS/vendor-ok.log" 2>&1 & pids+=($!)
PORT=$E500_PORT CHAOS=500 node apps/vendor/server.mjs > "$LOGS/vendor-500.log" 2>&1 & pids+=($!)
PORT=$HANG_PORT CHAOS=hang node apps/vendor/server.mjs > "$LOGS/vendor-hang.log" 2>&1 & pids+=($!)
NOTARY_PRIVATE_KEY=$NOTARY_KEY RUST_LOG=error "$BIN" notary --listen 127.0.0.1:$NOTARY_PORT --ca "$CA" > "$LOGS/notary.json" 2> "$LOGS/notary.log" & pids+=($!)
for p in $OK_PORT $E500_PORT $HANG_PORT $NOTARY_PORT; do wait_port "$p"; done
NOTARY_PUBLIC_KEY=$(jq -r .notaryKey "$LOGS/notary.json")
VERIFIER_PRIVATE_KEY=$VERIFIER_KEY "$BIN" serve --listen 127.0.0.1:$ATTESTOR_PORT --rpc "$RPC" --escrow "$ESCROW" \
  --notary 127.0.0.1:$NOTARY_PORT --ca "$CA" --predicate apps/attestor/predicates --storage "$LOGS/presentations" \
  --attempt-timeout-secs 10 \
  --resolve vendor.fermata.test:$OK_PORT=127.0.0.1:$OK_PORT \
  --resolve vendor.fermata.test:$E500_PORT=127.0.0.1:$E500_PORT \
  --resolve vendor.fermata.test:$HANG_PORT=127.0.0.1:$HANG_PORT > "$LOGS/attestor.log" 2>&1 & pids+=($!)
wait_port $ATTESTOR_PORT
VERIFIER_ADDRESS=$(curl -s --noproxy '*' http://127.0.0.1:$ATTESTOR_PORT/healthz | jq -r .signer)

echo "== register services"
CONFIG=$LOGS/gateway.config.json
register() { # label port
  $TSX scripts/register-service.ts --chain anvil --rpc "$RPC" --escrow "$ESCROW" --label "$1" \
    --upstream "https://vendor.fermata.test:$2" --notary-public-key "$NOTARY_PUBLIC_KEY" --verifier "$VERIFIER_ADDRESS" \
    --window 60 --config "$CONFIG" --tempo-amount 0.01 2>> "$LOGS/register.log"
}
SERVICE_OK=$(register quote-ok $OK_PORT)
SERVICE_500=$(register quote-500 $E500_PORT)
SERVICE_HANG=$(register quote-hang $HANG_PORT)

echo "== gateway"
GATEWAY_CONFIG=$CONFIG GATEWAY_PORT=$GATEWAY_PORT GATEWAY_STORAGE=$LOGS/calls GATEWAY_SWEEP_MS=2000 GATEWAY_REALM=127.0.0.1 \
  TEMPO_RPC_URL=$RPC FERMATA_ESCROW=$ESCROW ATTESTOR_URL=http://127.0.0.1:$ATTESTOR_PORT \
  RELAYER_PRIVATE_KEY=$RELAYER_KEY GATEWAY_SECRET_KEY=e2e-gateway-secret-key-at-least-32-bytes \
  GATEWAY_UPSTREAM_CA=$CA GATEWAY_RESOLVE=vendor.fermata.test:$OK_PORT=127.0.0.1:$OK_PORT \
  $TSX apps/gateway/src/main.ts > "$LOGS/gateway.log" 2>&1 & pids+=($!)
wait_port $GATEWAY_PORT || { cat "$LOGS/gateway.log"; exit 1; }

echo "== e2e (vitest)"
GATEWAY_URL=http://127.0.0.1:$GATEWAY_PORT TEMPO_RPC_URL=$RPC FERMATA_ESCROW=$ESCROW VERIFIER_ADDRESS=$VERIFIER_ADDRESS \
  FUNDER_PRIVATE_KEY=$FUNDER_KEY SERVICE_OK=$SERVICE_OK SERVICE_500=$SERVICE_500 SERVICE_HANG=$SERVICE_HANG FERMATA_E2E_CHAIN=anvil \
  pnpm -s -F @fermata/gateway test:e2e
echo "E2E GATEWAY OK (logs in $LOGS)"

if [ "${RUN_VALIDATOR:-1}" = 1 ]; then
  echo "== mppx validate (payment phase needs Moderato; informational)"
  (cd apps/gateway && CLAUDECODE= node_modules/.bin/mppx validate "http://127.0.0.1:$GATEWAY_PORT/s/$SERVICE_OK/v1/quote?symbol=BTC-USD" --yes) > "$LOGS/validator.txt" 2>&1 || true
  grep -iE "passed|failed|summary|✓|✗|×|fermata|tempo" "$LOGS/validator.txt" | tail -40 || true
fi
