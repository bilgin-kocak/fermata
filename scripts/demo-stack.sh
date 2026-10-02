#!/usr/bin/env bash
# The whole Fermata demo stack, every component a real process, left running in the background:
#   vendors  quote (CHAOS_RATE=0.03, the load-test service) · quote-ok · quote-500 (always 500) ·
#            quote-hang (never answers; 30 s window)
#   notary → attestor (serve) → gateway (+ dashboard at /dashboard)
#
#   bash scripts/demo-stack.sh up   [--chain anvil|moderato]   # writes out/demo/stack.json
#   bash scripts/demo-stack.sh down
#
# anvil: starts anvil, deploys the escrow, uses dev-only keys. moderato: uses the deployment in
# packages/sdk/src/deployments.json and the keys in .env (pnpm keys:init; fund them first).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
export NO_PROXY="${NO_PROXY:-},vendor.fermata.test,127.0.0.1,localhost"
export NODE_OPTIONS=--disable-warning=UNDICI-EHPA
DIR=out/demo
PIDS=$DIR/pids

CMD=${1:-up}; shift || true
CHAIN=anvil
while [ $# -gt 0 ]; do case "$1" in --chain) CHAIN=$2; shift 2 ;; *) echo "unknown argument $1" >&2; exit 2 ;; esac; done

down() {
  if [ -f "$PIDS" ]; then
    while read -r p; do kill "$p" 2>/dev/null || true; done < "$PIDS"
    rm -f "$PIDS"
    echo "demo stack stopped"
  fi
}
if [ "$CMD" = down ]; then down; exit 0; fi
[ "$CMD" = up ] || { echo "usage: demo-stack.sh up|down [--chain anvil|moderato]" >&2; exit 2; }
down
rm -rf "$DIR" && mkdir -p "$DIR"
trap '[ $? -eq 0 ] || { echo "demo stack failed; stopping what started" >&2; down; }' EXIT

ANVIL_PORT=${ANVIL_PORT:-8549}
NOTARY_PORT=7347; ATTESTOR_PORT=7348; GATEWAY_PORT=${GATEWAY_PORT:-4300}
QUOTE_PORT=8843; OK_PORT=8844; E500_PORT=8845; HANG_PORT=8846
TSX=node_modules/.bin/tsx
bg() { # log-name command... — start detached, remember the pid
  local name=$1; shift
  # setsid is Linux-only; macOS falls back to nohup.
  if command -v setsid > /dev/null; then setsid "$@" > "$DIR/$name.log" 2>&1 < /dev/null &
  else nohup "$@" > "$DIR/$name.log" 2>&1 < /dev/null & fi
  echo $! >> "$PIDS"
}
wait_port() { for _ in $(seq 150); do (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null && return 0; sleep 0.1; done; echo "port $1 did not open (see $DIR)" >&2; return 1; }

if [ "$CHAIN" = anvil ]; then
  RPC=http://127.0.0.1:$ANVIL_PORT
  NOTARY_KEY=0x2222222222222222222222222222222222222222222222222222222222222222
  VERIFIER_KEY=0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b
  RELAYER_KEY=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
  SECRET=demo-gateway-secret-key-at-least-32-bytes!!
  EXPLORER=""
else
  [ -f .env ] && { set -a; . ./.env; set +a; }
  RPC=${TEMPO_RPC_URL:-https://rpc.moderato.tempo.xyz}
  NOTARY_KEY=${NOTARY_PRIVATE_KEY:?run pnpm keys:init}; VERIFIER_KEY=${VERIFIER_PRIVATE_KEY:?}; RELAYER_KEY=${RELAYER_PRIVATE_KEY:?}
  SECRET=${GATEWAY_SECRET_KEY:?}
  EXPLORER=https://explore.testnet.tempo.xyz
  export NODE_USE_ENV_PROXY=1
fi

echo "== attestor build"
(cd apps/attestor && CARGO_NET_GIT_FETCH_WITH_CLI=true cargo +1.95.0 build --release -q)
BIN=$(cd apps/attestor && realpath "${CARGO_TARGET_DIR:-target}")/release/fermata-attest
[ -f apps/vendor/certs/ca.pem ] || bash apps/vendor/gen-certs.sh > "$DIR/certs.log"
CA=$PWD/apps/vendor/certs/ca.pem
if [ ! -f apps/dashboard/dist/index.html ] && [ -f apps/dashboard/package.json ]; then
  echo "== dashboard build"; pnpm -s -F @fermata/dashboard build > "$DIR/dashboard-build.log" 2>&1 || echo "dashboard build failed (see $DIR/dashboard-build.log)"
fi

if [ "$CHAIN" = anvil ]; then
  echo "== anvil + escrow"
  bg anvil anvil --chain-id 42431 --port "$ANVIL_PORT" --silent
  wait_port "$ANVIL_PORT"
  cp packages/sdk/src/deployments.json "$DIR/deployments.backup.json"
  bash scripts/deploy-escrow.sh --chain anvil --rpc "$RPC" > "$DIR/deploy.log" 2>&1 || { tail -20 "$DIR/deploy.log"; exit 1; }
  ESCROW=$(jq -r .FermataEscrow.networks.anvil.address packages/sdk/src/deployments.json)
  cp "$DIR/deployments.backup.json" packages/sdk/src/deployments.json # keep the committed entry stable
else
  ESCROW=$(jq -r '.FermataEscrow.networks.moderato.address // empty' packages/sdk/src/deployments.json)
  [ -n "$ESCROW" ] || { echo "no moderato deployment: pnpm escrow:deploy --chain moderato" >&2; exit 1; }
fi
echo "escrow $ESCROW on $CHAIN"

echo "== vendors, notary, attestor"
PORT=$QUOTE_PORT CHAOS_RATE=0.03 bg vendor-quote node apps/vendor/server.mjs
PORT=$OK_PORT bg vendor-ok node apps/vendor/server.mjs
PORT=$E500_PORT CHAOS=500 bg vendor-500 node apps/vendor/server.mjs
PORT=$HANG_PORT CHAOS=hang bg vendor-hang node apps/vendor/server.mjs
NOTARY_PRIVATE_KEY=$NOTARY_KEY RUST_LOG=error bg notary "$BIN" notary --listen 127.0.0.1:$NOTARY_PORT --ca "$CA"
for p in $QUOTE_PORT $OK_PORT $E500_PORT $HANG_PORT $NOTARY_PORT; do wait_port "$p"; done
NOTARY_PUBLIC_KEY=$(grep -o '"notaryKey":"0x[0-9a-f]*"' "$DIR/notary.log" | cut -d'"' -f4)
RESOLVE=()
for p in $QUOTE_PORT $OK_PORT $E500_PORT $HANG_PORT; do RESOLVE+=(--resolve "vendor.fermata.test:$p=127.0.0.1:$p"); done
VERIFIER_PRIVATE_KEY=$VERIFIER_KEY bg attestor "$BIN" serve --listen 127.0.0.1:$ATTESTOR_PORT --rpc "$RPC" --escrow "$ESCROW" \
  --notary 127.0.0.1:$NOTARY_PORT --ca "$CA" --predicate apps/attestor/predicates --storage "$DIR/presentations" \
  --attempt-timeout-secs 10 "${RESOLVE[@]}"
wait_port $ATTESTOR_PORT
VERIFIER_ADDRESS=$(curl -s --noproxy '*' http://127.0.0.1:$ATTESTOR_PORT/healthz | jq -r .signer)

echo "== services"
CONFIG=$DIR/gateway.config.json
register() { # label port window summary mcp-tool-name
  $TSX scripts/register-service.ts --chain "$CHAIN" --rpc "$RPC" --escrow "$ESCROW" --label "$1" \
    --upstream "https://vendor.fermata.test:$2" --notary-public-key "$NOTARY_PUBLIC_KEY" --verifier "$VERIFIER_ADDRESS" \
    --window "$3" --config "$CONFIG" --tempo-amount 0.01 --summary "$4" \
    --tool-name "$5" --tool-path '/v1/quote?symbol={symbol}' 2>> "$DIR/register.log"
}
SERVICE_QUOTE=$(register quote $QUOTE_PORT 120 "Crypto price quote, e.g. symbol BTC-USD (vendor fails ~3% of calls)." get_quote)
SERVICE_OK=$(register quote-ok $OK_PORT 120 "Crypto price quote, e.g. symbol BTC-USD (reliable vendor)." get_quote_reliable)
SERVICE_500=$(register quote-500 $E500_PORT 120 "Crypto price quote from a broken vendor (always HTTP 500) — for demonstrating refunds." get_quote_broken)
SERVICE_HANG=$(register quote-hang $HANG_PORT 30 "Crypto price quote from a vendor that never answers — for demonstrating timeout refunds." get_quote_silent)

echo "== gateway"
GATEWAY_CONFIG=$CONFIG GATEWAY_PORT=$GATEWAY_PORT GATEWAY_STORAGE=$DIR/calls GATEWAY_SWEEP_MS=2000 GATEWAY_REALM=127.0.0.1 \
  TEMPO_RPC_URL=$RPC FERMATA_ESCROW=$ESCROW ATTESTOR_URL=http://127.0.0.1:$ATTESTOR_PORT GATEWAY_EXPLORER=$EXPLORER \
  RELAYER_PRIVATE_KEY=$RELAYER_KEY GATEWAY_SECRET_KEY=$SECRET GATEWAY_UPSTREAM_CA=$CA \
  GATEWAY_RESOLVE=vendor.fermata.test:$QUOTE_PORT=127.0.0.1:$QUOTE_PORT \
  bg gateway "$TSX" apps/gateway/src/main.ts
wait_port "$GATEWAY_PORT" || { cat "$DIR/gateway.log"; exit 1; }

jq -n --arg chain "$CHAIN" --arg rpc "$RPC" --arg escrow "$ESCROW" --arg gateway "http://127.0.0.1:$GATEWAY_PORT" \
  --arg verifier "$VERIFIER_ADDRESS" --arg explorer "$EXPLORER" --arg attestor "http://127.0.0.1:$ATTESTOR_PORT" \
  --arg quote "$SERVICE_QUOTE" --arg ok "$SERVICE_OK" --arg e500 "$SERVICE_500" --arg hang "$SERVICE_HANG" \
  '{chain:$chain, rpc:$rpc, escrow:$escrow, gateway:$gateway, attestor:$attestor, verifier:$verifier, explorer:(if $explorer=="" then null else $explorer end),
    services:{quote:$quote, ok:$ok, "e500":$e500, hang:$hang}}' > "$DIR/stack.json"
echo "demo stack up on $CHAIN: gateway http://127.0.0.1:$GATEWAY_PORT (dashboard /dashboard) — $DIR/stack.json; stop with: bash scripts/demo-stack.sh down"
