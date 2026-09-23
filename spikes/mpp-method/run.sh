#!/usr/bin/env bash
# Probe 2 — custom MPP method next to tempo. Exit 0 and "PROBE 2: GREEN" only if the local legs pass.
set -euo pipefail
cd "$(dirname "$0")"
RESULT=RED; REASON=""; SPID=""
kill_group() { [ -n "${1:-}" ] && kill -- "-$1" 2>/dev/null || true; }
kill_stale() { for p in $(ps -eo pid,args | grep -E '[n]ode.*(tsx|server\.ts)' | grep -v 'run\.sh' | awk '{print $1}'); do kill "$p" 2>/dev/null || true; done; }
cleanup() { kill_group "$SPID"; echo "PROBE 2: $RESULT${REASON:+($REASON)}"; }
trap cleanup EXIT
fail() { REASON="$1"; echo "FAIL: $1" >&2; exit 1; }
mkdir -p logs
kill_stale; sleep 0.3
[ -d node_modules ] || pnpm install --reporter=silent
start_server() { setsid env "$@" npx tsx server.ts > logs/server.log 2>&1 & SPID=$!; for i in $(seq 1 60); do grep -q 'server ready' logs/server.log 2>/dev/null && break; sleep 0.25; done; grep -q 'server ready' logs/server.log || { cat logs/server.log; fail "server start"; }; }
stop_server() { kill_group "$SPID"; SPID=""; sleep 0.7; }

start_server
echo "== client-probe (custom method, receipt callId, replay) =="; npx tsx client-probe.ts > logs/client-probe.log 2>&1 || { tail -15 logs/client-probe.log; fail "client-probe"; }; grep '^OK' logs/client-probe.log
echo "== client-vanilla (both challenges, tempo fallback) =="; npx tsx client-vanilla.ts > logs/client-vanilla.log 2>&1 || { tail -15 logs/client-vanilla.log; fail "client-vanilla"; }; grep -E '^(402|vanilla|OK)' logs/client-vanilla.log
echo "== discovery =="; curl -sS http://127.0.0.1:4242/openapi.json > logs/openapi.json; jq -e '.paths["/quote"].post["x-payment-info"]' logs/openapi.json > /dev/null || { head -c 400 logs/openapi.json; fail "openapi.json"; }; echo "openapi.json ok: $(jq -c '.paths["/quote"].post["x-payment-info"]' logs/openapi.json | head -c 300)"
echo "== validator (mppx 0.11.0) =="
: > logs/validator.txt
for args in "http://127.0.0.1:4242" "http://127.0.0.1:4242 --endpoint POST:/quote --body {\"symbol\":\"BTC-USD\"}"; do
  echo "\$ npx mppx validate $args --yes" >> logs/validator.txt
  set +e; env -u CLAUDECODE NODE_USE_ENV_PROXY=1 NODE_NO_WARNINGS=1 timeout 180 npx mppx validate $args --yes 2>&1 | sed 's/\x1b\[[0-9;]*m//g' >> logs/validator.txt; rc=${PIPESTATUS[0]}; set -e
  echo "(exit $rc)" >> logs/validator.txt; echo "validator exit $rc: $(grep -E '^Summary' logs/validator.txt | tail -1)"
done
stop_server
echo "== error mapping (plain Error → 500) =="; start_server PROBE_THROW_PLAIN=1
npx tsx client-error.ts > logs/client-error.log 2>&1 || { tail -15 logs/client-error.log; fail "client-error"; }; grep '^OK' logs/client-error.log
stop_server
MOD=DEFERRED
if [ "${MODERATO:-}" = 1 ]; then start_server; MODERATO=1 NODE_USE_ENV_PROXY=1 npx tsx client-vanilla.ts > logs/moderato.log 2>&1 && MOD=GREEN || fail "moderato leg"; stop_server; else echo "moderato leg (tempo payment + validator payment) DEFERRED (rpc blocked)"; fi
echo "moderato: $MOD" > logs/summary.txt
RESULT=GREEN
