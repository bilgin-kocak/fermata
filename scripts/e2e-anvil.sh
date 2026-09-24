#!/usr/bin/env bash
# Local end-to-end rehearsal on Anvil's Tempo emulation (real TIP-20 precompiles, stablecoin fees):
# fresh chain → deploy FermataEscrow → record it in deployments.json → DELIVERED/FAILED/TIMEOUT round trip.
#   pnpm escrow:e2e:anvil            (port 8545; override with ANVIL_PORT)
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
PORT=${ANVIL_PORT:-8545}
RPC=http://127.0.0.1:$PORT
mkdir -p out

if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "something is already listening on $RPC; stop it or set ANVIL_PORT" >&2
  exit 1
fi
anvil --chain-id 42431 --port "$PORT" --silent > out/anvil-e2e.log 2>&1 &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
for _ in $(seq 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done

bash scripts/deploy-escrow.sh --chain anvil --rpc "$RPC"
NODE_USE_ENV_PROXY=1 NODE_OPTIONS=--disable-warning=UNDICI-EHPA \
  node_modules/.bin/tsx scripts/escrow-roundtrip.ts --chain anvil --rpc "$RPC"
