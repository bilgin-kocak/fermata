#!/usr/bin/env bash
# The whole Fermata demo stack, every component a real process, left running in the background:
#   vendors  quote (CHAOS_RATE=0.03, the load-test service) · quote-ok · quote-500 (always 500) ·
#            quote-hang (never answers; 30 s window)
#   notary → attestor (serve) → gateway (+ dashboard at /dashboard)
#
#   bash scripts/demo-stack.sh up   [--chain anvil|moderato]   # writes out/demo/stack.json
#   bash scripts/demo-stack.sh down
#   bash scripts/demo-stack.sh run  [--chain …]                # up, then stay in the foreground (systemd);
#                                                              # any component dying stops the stack, exit 1
#
# FERMATA_STATE_DIR (default out/demo) keeps calls, presentations, onboarded predicates and onboarded
# services across restarts; out/demo itself is recreated on every start.
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
[ "$CMD" = up ] || [ "$CMD" = run ] || { echo "usage: demo-stack.sh up|run|down [--chain anvil|moderato]" >&2; exit 2; }
down
rm -rf "$DIR" && mkdir -p "$DIR"
STATE=${FERMATA_STATE_DIR:-$DIR}
mkdir -p "$STATE/predicates" "$STATE/presentations" "$STATE/calls"
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
  # .env fills in only what the environment does not already set (systemd settings win), like the
  # Node scripts' loadEnvFile.
  if [ -f .env ]; then
    while IFS= read -r line; do
      [[ $line =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
      [ -n "${!BASH_REMATCH[1]:-}" ] || export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
    done < .env
  fi
  RPC=${TEMPO_RPC_URL:-https://rpc.moderato.tempo.xyz}
  NOTARY_KEY=${NOTARY_PRIVATE_KEY:?run pnpm keys:init}; VERIFIER_KEY=${VERIFIER_PRIVATE_KEY:?}; RELAYER_KEY=${RELAYER_PRIVATE_KEY:?}
  SECRET=${GATEWAY_SECRET_KEY:?}
  EXPLORER=https://explore.testnet.tempo.xyz
  export NODE_USE_ENV_PROXY=1
fi

if [ -n "${FERMATA_ATTEST_BIN:-}" ]; then
  BIN=$FERMATA_ATTEST_BIN # prebuilt (the Docker image): no cargo at runtime
else
  echo "== attestor build"
  (cd apps/attestor && CARGO_NET_GIT_FETCH_WITH_CLI=true cargo +1.95.0 build --release -q)
  BIN=$(cd apps/attestor && realpath "${CARGO_TARGET_DIR:-target}")/release/fermata-attest
fi
[ -f apps/vendor/certs/ca.pem ] || bash apps/vendor/gen-certs.sh > "$DIR/certs.log"
CA=$PWD/apps/vendor/certs/ca.pem
# (Re)build the dashboard when it is missing or older than its sources, so the stack never serves a stale UI.
if [ -f apps/dashboard/package.json ] && { [ ! -f apps/dashboard/dist/index.html ] ||
  [ -n "$(find apps/dashboard/src apps/dashboard/index.html apps/dashboard/vite.config.ts apps/dashboard/package.json -newer apps/dashboard/dist/index.html 2>/dev/null | head -1)" ]; }; then
  echo "== dashboard build"; pnpm -s -F @fermata/dashboard build > "$DIR/dashboard-build.log" 2>&1 || echo "dashboard build failed (see $DIR/dashboard-build.log)"
fi

if [ "$CHAIN" = anvil ]; then
  echo "== anvil + escrow"
  # Public mode mines a block every second, like a real chain, so settlement windows close on their own.
  ANVIL_ARGS=(); [ "${PUBLIC:-0}" = 1 ] && ANVIL_ARGS=(--block-time 1)
  bg anvil anvil --chain-id 42431 --port "$ANVIL_PORT" --silent ${ANVIL_ARGS[@]+"${ANVIL_ARGS[@]}"}
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
# Real vendors (REAL_VENDORS=npm,coinbase; default npm; "" for none) are checked against Mozilla's roots.
REAL_VENDORS=${REAL_VENDORS-npm}
NOTARY_PRIVATE_KEY=$NOTARY_KEY RUST_LOG=error bg notary "$BIN" notary --listen 127.0.0.1:$NOTARY_PORT --ca "$CA" --roots mozilla
for p in $QUOTE_PORT $OK_PORT $E500_PORT $HANG_PORT $NOTARY_PORT; do wait_port "$p"; done
NOTARY_PUBLIC_KEY=$(grep -o '"notaryKey":"0x[0-9a-f]*"' "$DIR/notary.log" | cut -d'"' -f4)
RESOLVE=()
for p in $QUOTE_PORT $OK_PORT $E500_PORT $HANG_PORT; do RESOLVE+=(--resolve "vendor.fermata.test:$p=127.0.0.1:$p"); done
# Behind an egress proxy (like this build environment), real vendors are reached through a CONNECT
# tunnel; local demo vendors (pinned with --resolve) never are.
PROXY_ENV=(); UPSTREAM_PROXY=${FERMATA_UPSTREAM_PROXY:-${HTTPS_PROXY:-${https_proxy:-}}}
[ -n "$UPSTREAM_PROXY" ] && PROXY_ENV=(FERMATA_UPSTREAM_PROXY="$UPSTREAM_PROXY")
bg attestor env ${PROXY_ENV[@]+"${PROXY_ENV[@]}"} VERIFIER_PRIVATE_KEY=$VERIFIER_KEY "$BIN" serve --listen 127.0.0.1:$ATTESTOR_PORT --rpc "$RPC" --escrow "$ESCROW" \
  --notary 127.0.0.1:$NOTARY_PORT --ca "$CA" --roots mozilla --predicate apps/attestor/predicates --predicate "$STATE/predicates" --storage "$STATE/presentations" \
  --attempts "${ATTEST_ATTEMPTS:-$([ "${PUBLIC:-0}" = 1 ] && echo 1 || echo 3)}" --attempt-timeout-secs 10 "${RESOLVE[@]}"
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
register_real() { # label upstream predicate summary tool-name tool-path example-path
  $TSX scripts/register-service.ts --chain "$CHAIN" --rpc "$RPC" --escrow "$ESCROW" --label "$1" --upstream "$2" \
    --predicate "apps/attestor/predicates/$3" --notary-public-key "$NOTARY_PUBLIC_KEY" --verifier "$VERIFIER_ADDRESS" \
    --window 120 --config "$CONFIG" --summary "$4" --tool-name "$5" --tool-path "$6" --example-path "$7" 2>> "$DIR/register.log"
}
SERVICE_NPM=""; SERVICE_NPM404=""; SERVICE_COINBASE=""
case ",$REAL_VENDORS," in *,npm,*)
  SERVICE_NPM=$(register_real npm-tags https://registry.npmjs.org npm-dist-tags-v1.json \
    "Latest published versions (dist-tags) of an npm package, from the real public npm registry." \
    npm_latest_version '/-/package/{package}/dist-tags' /-/package/mppx/dist-tags)
  # Public mode's "npm 404" button pays this separate listing: npm's correct 404 is a proven failure,
  # and it must not count against the npm vendor's score.
  [ "${PUBLIC:-0}" = 1 ] && SERVICE_NPM404=$(register_real npm-missing https://registry.npmjs.org npm-dist-tags-v1.json \
    "Demo listing: the real npm registry asked for a package that does not exist (shows a proven 404 refund)." \
    npm_missing_demo '/-/package/{package}/dist-tags' /-/package/no-such-package-fermata-zz/dist-tags) ;; esac
case ",$REAL_VENDORS," in *,coinbase,*)
  SERVICE_COINBASE=$(register_real cb-spot https://api.coinbase.com coinbase-spot-v1.json \
    "Coinbase spot price for a pair such as BTC-USD, from the real public Coinbase API." \
    get_spot_price '/v2/prices/{pair}/spot' /v2/prices/BTC-USD/spot) ;; esac

# Public "try it" mode (PUBLIC=1): the demo buttons and the server-side demo agent that pays for them.
PUBLIC_ENV=()
if [ "${PUBLIC:-0}" = 1 ]; then
  echo "== public demo mode"
  KINDS=$(jq -n --arg ok "$SERVICE_OK" --arg e500 "$SERVICE_500" --arg hang "$SERVICE_HANG" --arg npm "$SERVICE_NPM" --arg npm404 "$SERVICE_NPM404" '
    {reliable: {serviceId: $ok, path: "/v1/quote?symbol=BTC-USD", label: "Reliable vendor", description: "A quote API that answers correctly: the proof passes and the vendor is paid."},
     broken: {serviceId: $e500, path: "/v1/quote?symbol=ETH-USD", label: "Broken vendor", description: "Answers HTTP 500: the proof shows the failure and you are refunded."},
     silent: {serviceId: $hang, path: "/v1/quote?symbol=SOL-USD", label: "Silent vendor", description: "Never answers: no proof, no verdict; the contract refunds after the 30 s window."}}
    + (if $npm == "" then {} else
      {npm: {serviceId: $npm, path: "/-/package/mppx/dist-tags", label: "Real API: npm registry", description: "The public npm registry over the open internet: a real 200, proved and paid."},
       "npm-404": {serviceId: (if $npm404 == "" then $npm else $npm404 end), path: "/-/package/no-such-package-fermata-zz/dist-tags", label: "Real API: npm 404", description: "npm\u0027s genuine 404 for a missing package: proved, and refunded."}} end)')
  jq --argjson kinds "$KINDS" '.demo = {kinds: $kinds, perIpSeconds: (env.DEMO_PER_IP_SECONDS // "60" | tonumber), perIpPerDay: (env.DEMO_PER_IP_PER_DAY // "15" | tonumber), dailyCap: (env.DEMO_DAILY_CAP // "500" | tonumber)}' "$CONFIG" > "$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"
  if [ "$CHAIN" = anvil ]; then
    DEMO_AGENT_PRIVATE_KEY=$(cast wallet new --json | jq -r '(.data // .) | if type == "array" then .[0] else . end | .private_key')
    cast send -q --rpc-url "$RPC" --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
      0x20C0000000000000000000000000000000000000 'transfer(address,uint256)' "$(cast wallet address "$DEMO_AGENT_PRIVATE_KEY")" 10000000 > /dev/null
  fi
  DEMO_AGENT_PRIVATE_KEY=${DEMO_AGENT_PRIVATE_KEY:-${AGENT_PRIVATE_KEY:-}}
  PUBLIC_ENV=(GATEWAY_PUBLIC=1 DEMO_AGENT_PRIVATE_KEY="${DEMO_AGENT_PRIVATE_KEY:?set DEMO_AGENT_PRIVATE_KEY (or AGENT_PRIVATE_KEY) to a funded testnet key}"
    ONBOARD_PREDICATE_DIR="$(cd "$STATE" && pwd)/predicates" ONBOARD_SERVICES_FILE="$(cd "$STATE" && pwd)/onboarded.json" ${PROXY_ENV[@]+"${PROXY_ENV[@]}"})
  # services onboarded before this start keep being served
  if [ -f "$STATE/onboarded.json" ]; then
    jq -s '(.[0].services | map(.serviceId | ascii_downcase)) as $have
      | .[0].services += [(.[1].services // [])[] | select((.serviceId | ascii_downcase) as $id | $have | index($id) | not)] | .[0]' \
      "$CONFIG" "$STATE/onboarded.json" > "$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"
  fi
  [ -n "${ONBOARD_OPERATOR_PRIVATE_KEY:-}" ] && PUBLIC_ENV+=(ONBOARD_OPERATOR_PRIVATE_KEY="$ONBOARD_OPERATOR_PRIVATE_KEY")
fi

echo "== gateway"
bg gateway env ${PUBLIC_ENV[@]+"${PUBLIC_ENV[@]}"} GATEWAY_CONFIG=$CONFIG GATEWAY_PORT=$GATEWAY_PORT GATEWAY_STORAGE=$STATE/calls GATEWAY_SWEEP_MS=2000 GATEWAY_REALM=${GATEWAY_REALM:-127.0.0.1} \
  TEMPO_RPC_URL=$RPC FERMATA_ESCROW=$ESCROW ATTESTOR_URL=http://127.0.0.1:$ATTESTOR_PORT GATEWAY_EXPLORER=$EXPLORER \
  GATEWAY_FROM_BLOCK="$(jq -r ".FermataEscrow.networks.$CHAIN.deployBlock // 0" packages/sdk/src/deployments.json)" \
  RELAYER_PRIVATE_KEY=$RELAYER_KEY GATEWAY_SECRET_KEY=$SECRET GATEWAY_UPSTREAM_CA=$CA \
  GATEWAY_RESOLVE=vendor.fermata.test:$QUOTE_PORT=127.0.0.1:$QUOTE_PORT \
  "$TSX" apps/gateway/src/main.ts
wait_port "$GATEWAY_PORT" || { cat "$DIR/gateway.log"; exit 1; }

jq -n --arg chain "$CHAIN" --arg rpc "$RPC" --arg escrow "$ESCROW" --arg gateway "http://127.0.0.1:$GATEWAY_PORT" \
  --arg verifier "$VERIFIER_ADDRESS" --arg explorer "$EXPLORER" --arg attestor "http://127.0.0.1:$ATTESTOR_PORT" \
  --arg quote "$SERVICE_QUOTE" --arg ok "$SERVICE_OK" --arg e500 "$SERVICE_500" --arg hang "$SERVICE_HANG" \
  --arg npm "$SERVICE_NPM" --arg coinbase "$SERVICE_COINBASE" \
  '{chain:$chain, rpc:$rpc, escrow:$escrow, gateway:$gateway, attestor:$attestor, verifier:$verifier, explorer:(if $explorer=="" then null else $explorer end),
    services:{quote:$quote, ok:$ok, "e500":$e500, hang:$hang},
    real:({} + (if $npm=="" then {} else {npm:$npm} end) + (if $coinbase=="" then {} else {coinbase:$coinbase} end))}' > "$DIR/stack.json"
echo "demo stack up on $CHAIN: gateway http://127.0.0.1:$GATEWAY_PORT (dashboard /dashboard) — $DIR/stack.json; stop with: bash scripts/demo-stack.sh down"

if [ "$CMD" = run ]; then
  # Foreground supervision for systemd: stop everything on SIGTERM; if any component dies, stop the
  # rest and exit 1 so the unit restarts the whole stack.
  trap 'down; exit 0' TERM INT
  while sleep 5; do
    while read -r p; do
      kill -0 "$p" 2>/dev/null || { echo "a component (pid $p) exited; stopping the stack" >&2; down; exit 1; }
    done < "$PIDS"
  done
fi

