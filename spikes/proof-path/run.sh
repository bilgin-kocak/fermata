#!/usr/bin/env bash
# Probe 1 — proof path. Exit 0 and a final "PROBE 1: GREEN" line only if every local step passes.
# Moderato leg: set MODERATO_PK (funded key) and reachable RPC; otherwise reported as DEFERRED.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.foundry/bin:$PATH"
export NO_PROXY="${NO_PROXY:-},vendor.fermata.test,127.0.0.1"
NKEY=0x2222222222222222222222222222222222222222222222222222222222222222   # dev-only notary key
SIGNER=0x0000000000000000000000000000000000000000000000000000000000000001 # dev-only verifier key
VERIFIER=0x7e5f4552091a69125d5dfcb7b8c2659029395bdf                        # address of SIGNER
CALL=0x1111111111111111111111111111111111111111111111111111111111111111
ORIGIN=https://vendor.fermata.test:8443
RESULT=RED; REASON=""
pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; echo "PROBE 1: $RESULT${REASON:+($REASON)}"; }
trap cleanup EXIT
fail() { REASON="$1"; echo "FAIL: $1" >&2; exit 1; }
VENDOR_PID=""
start_vendor() { CHAOS="${1:-}" PORT=8443 node vendor/server.mjs > "logs/vendor-${1:-ok}.log" 2>&1 & VENDOR_PID=$!; pids+=($VENDOR_PID); sleep 0.7; }
stop_vendor() { kill "$VENDOR_PID" 2>/dev/null || true; sleep 0.3; }
mkdir -p logs out

echo "== build =="
CARGO_NET_GIT_FETCH_WITH_CLI=true cargo +1.95.0 build --release -q 2>&1 | tail -3 || fail "cargo build"
./gen-certs.sh > logs/certs.log 2>&1 || fail "gen-certs"

echo "== openssl preflight =="
start_vendor
echo | openssl s_client -tls1_2 -cipher ECDHE-ECDSA-AES128-GCM-SHA256 -curves prime256v1 -servername vendor.fermata.test -CAfile certs/ca.pem -connect 127.0.0.1:8443 2>&1 | grep -q 'Verify return code: 0' || fail "openssl preflight"

echo "== notary =="
./target/release/notary --listen 127.0.0.1:7047 --ca certs/ca.pem --key $NKEY > logs/notary.log 2>&1 & pids+=($!); sleep 0.7
NPUB=$(grep -o '0x[0-9a-f]\{66\}' logs/notary.log | head -1); [ -n "$NPUB" ] || fail "notary key"
echo "notary key $NPUB"

prove() { # $1 out file, $2 log suffix; prints totalMs. Retried once: MPC can deadlock under CPU contention (150 s guard).
  local attempt
  for attempt in 1 2; do
    if timeout 150 ./target/release/prove --notary 127.0.0.1:7047 --server 127.0.0.1:8443 --server-name vendor.fermata.test --ca certs/ca.pem --method POST --path /v1/quote --body '{"symbol":"BTC-USD"}' --call-id $CALL --out "$1" > "logs/prove-$2.json" 2> "logs/prove-$2.log"; then
      jq -r .totalMs "logs/prove-$2.json"; return 0
    fi
    echo "prove attempt $attempt failed (see logs/prove-$2.log)" >&2
  done
  return 1
}
verify() { # $1 presentation, $2 out verdict, extra args...
  local p=$1 o=$2; shift 2
  ./target/release/verify --presentation "$p" --ca certs/ca.pem --notary-key "$NPUB" --origin $ORIGIN --predicate predicate.json --call-id $CALL --signer $SIGNER --out "$o" "$@"
}

echo "== prove x3 (median) =="
ms=(); for i in 1 2 3; do ms+=("$(prove out/presentation.tlsn ok$i)"); done
MEDIAN=$(printf '%s\n' "${ms[@]}" | sort -n | sed -n 2p); echo "prove wall-clock ms: ${ms[*]} -> median $MEDIAN"
PBYTES=$(jq -r .presentationBytes logs/prove-ok3.json)

echo "== verify (expect DELIVERED) =="
verify out/presentation.tlsn out/verdict.json > logs/verify-ok.log 2>&1 || fail "verify ok"
[ "$(jq -r .outcome out/verdict.json)" = DELIVERED ] || fail "outcome not DELIVERED"
grep -q '"lenSent"' out/verdict.json; grep -q "POST /v1/quote" logs/verify-ok.log || fail "request line not printed"
stop_vendor

echo "== chaos runs (expect FAILED verdicts) =="
for mode in 500 truncate; do
  start_vendor $mode
  prove "out/chaos-$mode.tlsn" "$mode" > /dev/null || fail "prove $mode"
  verify "out/chaos-$mode.tlsn" "out/verdict-$mode.json" > "logs/verify-$mode.log" 2>&1 || fail "verify $mode errored (must produce a FAILED verdict, not an error)"
  [ "$(jq -r .outcome out/verdict-$mode.json)" = FAILED ] || fail "chaos $mode not FAILED"
  echo "chaos $mode -> FAILED: $(jq -c .failures out/verdict-$mode.json)"
  stop_vendor
done

echo "== negatives (expect non-zero) =="
NEG=out/neg.json
! verify out/presentation.tlsn $NEG --notary-key "0x03${NPUB:4}" > logs/neg-key.log 2>&1 || fail "wrong notary key accepted"
! verify out/presentation.tlsn $NEG --origin https://evil.fermata.test:8443 > logs/neg-origin.log 2>&1 || fail "wrong origin accepted"
! verify out/presentation.tlsn $NEG --call-id 0x2222222222222222222222222222222222222222222222222222222222222222 > logs/neg-call.log 2>&1 || fail "wrong callId accepted"
python3 -c "b=bytearray(open('out/presentation.tlsn','rb').read()); b[len(b)//2]^=1; open('out/tampered.tlsn','wb').write(b)"
! verify out/tampered.tlsn $NEG > logs/neg-tamper.log 2>&1 || fail "tampered presentation accepted"
echo "4/4 negatives rejected"

echo "== forge test (EIP-712 cross-check) =="
(cd contract && { [ -d lib/forge-std ] || forge install foundry-rs/forge-std --no-git > ../logs/forge-install.log 2>&1; })
./target/release/verify --vector > contract/vector.json
(cd contract && forge test > ../logs/forge.log 2>&1) || { tail -20 logs/forge.log; fail "forge test"; }; grep -E 'tests passed' logs/forge.log | tail -1

echo "== anvil settle =="
anvil --chain-id 42431 --port 8545 --silent & pids+=($!); sleep 2
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ADDR=$(cd contract && forge create src/SpikeSettle.sol:SpikeSettle --rpc-url http://127.0.0.1:8545 --private-key $PK --broadcast --constructor-args $VERIFIER 2>&1 | grep -o 'Deployed to: 0x[0-9a-fA-F]*' | cut -d' ' -f3); [ -n "$ADDR" ] || fail "deploy"
verify out/presentation.tlsn out/verdict-anvil.json --escrow "$ADDR" --chain-id 42431 > /dev/null || fail "re-sign"
V=out/verdict-anvil.json; T="($(jq -r .verdict.call_id $V),$(jq -r .verdict.service_id $V),$(jq -r .verdict.request_hash $V),$(jq -r .verdict.predicate_hash $V),$(jq -r .verdict.outcome $V),$(jq -r .verdict.presentation_hash $V),$(jq -r .verdict.response_hash $V),$(jq -r .verdict.issued_at $V))"; SIG=$(jq -r .signatureBytes $V)
SETTLE_SIG="settle((bytes32,bytes32,bytes32,bytes32,uint8,bytes32,bytes32,uint64),bytes)"
cast send "$ADDR" "$SETTLE_SIG" "$T" "$SIG" --rpc-url http://127.0.0.1:8545 --private-key $PK > logs/settle.log 2>&1 || fail "settle"
grep -q 'status *true' logs/settle.log || fail "settle status"
[ "$(cast call "$ADDR" 'settled(bytes32)(uint8)' $CALL --rpc-url http://127.0.0.1:8545)" = 1 ] || fail "settled != 1"
! cast send "$ADDR" "$SETTLE_SIG" "$T" "$SIG" --rpc-url http://127.0.0.1:8545 --private-key $PK > logs/settle-replay.log 2>&1 || fail "replay accepted"
grep -q AlreadySettled logs/settle-replay.log || fail "replay revert reason"
echo "anvil: SpikeSettle $ADDR settled callId, replay reverted (AlreadySettled)"

echo "== moderato leg =="
MOD=DEFERRED
if [ -n "${MODERATO_PK:-}" ] && cast chain-id --rpc-url https://rpc.moderato.tempo.xyz > /dev/null 2>&1; then
  MADDR=$(cd contract && forge create src/SpikeSettle.sol:SpikeSettle --rpc-url https://rpc.moderato.tempo.xyz --private-key "$MODERATO_PK" --broadcast --constructor-args $VERIFIER 2>&1 | grep -o 'Deployed to: 0x[0-9a-fA-F]*' | cut -d' ' -f3)
  verify out/presentation.tlsn out/verdict-moderato.json --escrow "$MADDR" --chain-id 42431 > /dev/null
  V=out/verdict-moderato.json; T="($(jq -r .verdict.call_id $V),$(jq -r .verdict.service_id $V),$(jq -r .verdict.request_hash $V),$(jq -r .verdict.predicate_hash $V),$(jq -r .verdict.outcome $V),$(jq -r .verdict.presentation_hash $V),$(jq -r .verdict.response_hash $V),$(jq -r .verdict.issued_at $V))"; SIG=$(jq -r .signatureBytes $V)
  TX=$(cast send "$MADDR" "$SETTLE_SIG" "$T" "$SIG" --rpc-url https://rpc.moderato.tempo.xyz --private-key "$MODERATO_PK" --json | jq -r .transactionHash)
  echo "moderato: SpikeSettle $MADDR, settle tx https://explore.testnet.tempo.xyz/tx/$TX"; MOD="GREEN $TX"
else
  echo "moderato leg DEFERRED (rpc blocked or MODERATO_PK unset)"
fi

echo "== summary =="
echo "prove median ${MEDIAN} ms (runs: ${ms[*]}), presentation ${PBYTES} bytes, moderato: $MOD" | tee out/summary.txt
RESULT=GREEN
