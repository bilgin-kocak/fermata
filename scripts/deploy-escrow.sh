#!/usr/bin/env bash
# Deploys FermataEscrow and records address + ABI in packages/sdk/src/deployments.json.
#
#   pnpm escrow:deploy --chain moderato      # key from .env (DEPLOYER_PRIVATE_KEY, faucet-funded)
#   pnpm escrow:deploy --chain anvil         # anvil --chain-id 42431, anvil dev account 0
#   options: --rpc URL
#
# Owner / treasury / fee come from FERMATA_OWNER, FERMATA_TREASURY, FERMATA_FEE_BPS (see .env.example).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"

CHAIN=anvil
RPC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --chain) CHAIN=$2; shift 2 ;;
    --rpc) RPC=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -f .env ]; then set -a; . ./.env; set +a; fi
# Empty values in .env mean "use the default": forge's envOr would fail to parse them.
for v in DEPLOYER_PRIVATE_KEY FERMATA_OWNER FERMATA_TREASURY FERMATA_FEE_BPS; do
  if [ -z "${!v:-}" ]; then unset "$v"; fi
done

case "$CHAIN" in
  moderato)
    RPC=${RPC:-${TEMPO_RPC_URL:-https://rpc.moderato.tempo.xyz}}
    if [ -z "${DEPLOYER_PRIVATE_KEY:-}" ]; then
      echo "DEPLOYER_PRIVATE_KEY is not set: run 'pnpm keys:init', then fund the deployer (see its output)" >&2
      exit 1
    fi
    ;;
  anvil)
    RPC=${RPC:-${ANVIL_RPC_URL:-http://127.0.0.1:8545}}
    # Anvil's well-known dev account 0 (funded by anvil itself; never use it on a real network).
    DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
    ;;
  *) echo "--chain must be anvil or moderato" >&2; exit 2 ;;
esac
export DEPLOYER_PRIVATE_KEY

CHAIN_ID=$(cast chain-id --rpc-url "$RPC")
if [ "$CHAIN_ID" != 42431 ]; then echo "expected chain id 42431 at $RPC, got $CHAIN_ID" >&2; exit 1; fi
echo "deploying FermataEscrow to $CHAIN ($RPC) from $(cast wallet address "$DEPLOYER_PRIVATE_KEY")"

cd contracts
rm -rf broadcast/Deploy.s.sol/42431 # export-deployment.ts must never read a stale run
mkdir -p broadcast
LOG=broadcast/deploy-$CHAIN.log
if ! forge script script/Deploy.s.sol:Deploy --network tempo --rpc-url "$RPC" --broadcast 2>&1 | tee "$LOG"; then
  echo "forge script failed (see contracts/$LOG); retrying with --skip-simulation (node-side gas estimation)" >&2
  rm -rf broadcast/Deploy.s.sol/42431
  forge script script/Deploy.s.sol:Deploy --network tempo --rpc-url "$RPC" --broadcast --skip-simulation 2>&1 | tee -a "$LOG"
fi
cd ..

NODE_USE_ENV_PROXY=1 NODE_OPTIONS=--disable-warning=UNDICI-EHPA node_modules/.bin/tsx scripts/export-deployment.ts --chain "$CHAIN" --rpc "$RPC"
