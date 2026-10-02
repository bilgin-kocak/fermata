#!/usr/bin/env bash
# Can Fermata prove this vendor? Checks a host against TLSNotary v0.1.0-alpha.15's TLS profile
# (FACTS §12.4): TLS 1.2, ECDHE with AES-128-GCM, the P-256 group, and a certificate that chains to
# Mozilla's roots. Then it makes one plain HTTP/1.1 request (no ALPN, no compression) and prints the
# status, content type and body size the predicate will see.
#
#   bash scripts/probe-tls.sh api.coinbase.com [/v2/prices/BTC-USD/spot]
#   HTTPS_PROXY=http://127.0.0.1:3128 bash scripts/probe-tls.sh registry.npmjs.org /-/package/mppx/dist-tags
#
# PASS means `fermata-attest prove --roots mozilla` should work; the real test is `pnpm demo:real`.
set -uo pipefail
HOST=${1:?usage: probe-tls.sh <host> [path]}
PATH_=${2:-/}
PROXY=${HTTPS_PROXY:-${https_proxy:-}}
PROXY_ARGS=()
[ -n "$PROXY" ] && PROXY_ARGS=(-proxy "$(echo "$PROXY" | sed -E 's#^https?://##; s#/$##; s#.*@##')")
# Verify against Mozilla's root program only (the bundle Node ships, as --roots mozilla does), never
# the system store: that may trust a TLS-intercepting proxy's CA.
MOZILLA=$(mktemp); trap 'rm -f "$MOZILLA"' EXIT
node -e "process.stdout.write(require('tls').rootCertificates.join('\n'))" > "$MOZILLA" || { echo "needs node"; exit 2; }
CA_ARGS=(-no-CAfile -no-CApath -no-CAstore -CAfile "$MOZILLA")

out=$( (printf 'GET %s HTTP/1.1\r\nHost: %s\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nUser-Agent: fermata-probe/0.1\r\nConnection: close\r\n\r\n' "$PATH_" "$HOST"; sleep 3) |
  timeout 20 openssl s_client "${PROXY_ARGS[@]}" -connect "$HOST:443" -servername "$HOST" -tls1_2 \
    -cipher 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256' -curves prime256v1 \
    -verify_return_error "${CA_ARGS[@]}" -ign_eof 2>&1)

cipher=$(echo "$out" | grep -m1 -oE 'Cipher is [A-Z0-9-]+' | awk '{print $3}')
group=$(echo "$out" | grep -m1 -oE 'Server Temp Key: [^,]+, [^,]+' | sed 's/Server Temp Key: //')
issuer=$(echo "$out" | grep -m1 -E '^issuer=' | sed 's/^issuer=//')
verify=$(echo "$out" | grep -m1 -oE 'Verify return code: [0-9]+ \([^)]*\)')
status=$(echo "$out" | grep -m1 -oE '^HTTP/1\.[01] [0-9]{3}' | awk '{print $2}')
ctype=$(echo "$out" | grep -m1 -i '^content-type:' | cut -d' ' -f2- | tr -d '\r')
clen=$(echo "$out" | grep -m1 -i '^content-length:' | cut -d' ' -f2 | tr -d '\r')

echo "host:        $HOST${PROXY:+ (through proxy)}"
echo "cipher:      ${cipher:-none}"
echo "key group:   ${group:-none}"
echo "issuer:      ${issuer:-none}"
echo "certificate: ${verify:-none}"
echo "HTTP/1.1:    ${status:-no response}  ${ctype}  ${clen:+$clen bytes}"

fail() { echo "FAIL: $1"; exit 1; }
verr=$(echo "$out" | grep -m1 -oE 'verify error:num=[0-9]+:[^[:cntrl:]]*')
[ -z "$verr" ] || fail "certificate does not chain to a Mozilla root ($verr); a TLS-intercepting proxy also ends here"
[ -n "$cipher" ] || fail "no TLS 1.2 handshake with AES-128-GCM on P-256 (TLSNotary supports nothing else; or the proxy refused the host)"
case "$group" in *prime256v1*|*P-256*) ;; *) fail "key exchange group is not P-256: $group" ;; esac
echo "$verify" | grep -q 'code: 0 ' || fail "certificate did not verify (${verify}); an intercepting proxy also ends here"
[ -n "$status" ] || fail "no HTTP/1.1 response"
[ -z "$clen" ] || [ "$clen" -le 16000 ] || fail "body $clen bytes exceeds the prover's 16 KB receive budget"
echo "PASS: TLSNotary-compatible; HTTP $status"
