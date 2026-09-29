#!/usr/bin/env bash
# Probe 3 — TIP-20 permit + transferFromWithMemo. Exit 0 and "PROBE 3: GREEN" only if forge test and the anvil leg pass.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.foundry/bin:$PATH"
RESULT=RED; REASON=""; pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; echo "PROBE 3: $RESULT${REASON:+($REASON)}"; }
trap cleanup EXIT
fail() { REASON="$1"; echo "FAIL: $1" >&2; exit 1; }
mkdir -p logs
[ -d node_modules ] || pnpm install --ignore-workspace --reporter=silent
[ -d lib/forge-std ] || forge install foundry-rs/forge-std --no-git > logs/forge-install.log 2>&1
echo "== forge test (mock TIP-20 + permit + memo log) =="
forge test > logs/forge.log 2>&1 || { tail -20 logs/forge.log; fail "forge test"; }; grep -E 'tests passed' logs/forge.log | tail -1
forge build -q > /dev/null 2>&1 || fail "forge build"
echo "== anvil leg (Anvil 1.8.3 Tempo emulation: real TIP-20 precompile at 0x20c0..0000) =="
anvil --chain-id 42431 --port 8546 --silent & pids+=($!); sleep 2
npx tsx script/probe.ts --chain anvil 2>&1 | tee logs/anvil.log | tail -4 || fail "anvil leg"
grep -q '^OK:' logs/anvil.log || fail "anvil leg did not print OK"
echo "== moderato leg =="
MOD=DEFERRED
if [ -n "${MODERATO_PK:-}" ] && NODE_USE_ENV_PROXY=1 cast chain-id --rpc-url https://rpc.moderato.tempo.xyz > /dev/null 2>&1; then
  NODE_USE_ENV_PROXY=1 npx tsx script/probe.ts --chain moderato 2>&1 | tee logs/moderato.log | tail -4 && MOD=GREEN || fail "moderato leg"
else
  echo "moderato leg DEFERRED (rpc blocked or MODERATO_PK unset)"
fi
echo "moderato: $MOD" > logs/summary.txt
RESULT=GREEN
