#!/usr/bin/env bash
# Is the hosted demo working? Checks a running gateway end to end, from the outside:
#
#   bash deploy/smoke.sh https://fermata.example.com        (or http://127.0.0.1:4300 locally)
#
# /info, /scores, /demo/status, the MCP endpoint, one paid demo call per available kind among
# reliable / npm (released) and broken (refunded), each proof re-verified offline. Exit 0 only if all pass.
set -uo pipefail
BASE=${1:?usage: smoke.sh <base-url>}
BASE=${BASE%/}
CURL=(curl -sS --max-time 120 --noproxy '127.0.0.1,localhost')
pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass + 1)); }
ko() { echo "FAIL  $1"; fail=$((fail + 1)); }

info=$("${CURL[@]}" "$BASE/info") && [ "$(echo "$info" | jq -r .escrow)" != null ] && ok "/info: escrow $(echo "$info" | jq -r .escrow), chain $(echo "$info" | jq -r .chainId)" || ko "/info"
scores=$("${CURL[@]}" "$BASE/scores") && echo "$scores" | jq -e '.scores | type == "array"' > /dev/null && ok "/scores: $(echo "$scores" | jq '.scores | length') vendors" || ko "/scores"
status=$("${CURL[@]}" "$BASE/demo/status")
if echo "$status" | jq -e .enabled > /dev/null 2>&1; then
  ok "/demo/status: $(echo "$status" | jq -r '[.kinds[].id] | join(", ")'); read-only: $(echo "$status" | jq -r '.readOnly // "no"')"
else
  ko "/demo/status (public mode off?)"
fi
tools=$("${CURL[@]}" -X POST "$BASE/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
echo "$tools" | jq -e '.result.tools | length > 0' > /dev/null 2>&1 && ok "MCP tools: $(echo "$tools" | jq -r '[.result.tools[].name] | join(", ")')" || ko "MCP tools/list"

demo() { # kind expected-outcome
  local kind=$1 want=$2 r
  echo "$status" | jq -e --arg k "$kind" '[.kinds[].id] | index($k)' > /dev/null 2>&1 || return 0
  for _ in 1 2 3 4; do
    r=$("${CURL[@]}" -X POST "$BASE/demo/call" -H 'content-type: application/json' -d "{\"kind\":\"$kind\"}")
    wait=$(echo "$r" | jq -r '.retryAfterMs // empty')
    [ -z "$wait" ] && break
    sleep $(( wait / 1000 + 1 ))
  done
  if [ "$(echo "$r" | jq -r .outcome)" = "$want" ]; then
    call=$(echo "$r" | jq -r .callId)
    v=$("${CURL[@]}" -X POST "$BASE/proofs/$call/verify")
    if [ "$(echo "$v" | jq -r .ok)" = true ]; then ok "demo $kind: $want, proof re-verified (call ${call:0:10}…)"; else ko "demo $kind: $want but re-verify failed"; fi
  else
    ko "demo $kind: expected $want, got $(echo "$r" | jq -c '{status, outcome, error}')"
  fi
}
demo reliable DELIVERED
demo broken FAILED
demo npm DELIVERED

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
