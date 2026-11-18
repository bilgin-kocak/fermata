#!/usr/bin/env bash
# Dev CA + P-256 leaf for vendor.fermata.test (no mkcert here), valid 825 days.
#   bash apps/vendor/gen-certs.sh [dir]     dir defaults to apps/vendor/certs
# Output: <dir>/{ca.pem,ca-key.pem,vendor.pem,vendor-key.pem}
set -euo pipefail
OUT=${1:-"$(dirname "$0")/certs"}
mkdir -p "$OUT" && cd "$OUT"
[ -f ca.pem ] && [ -f vendor.pem ] && { echo "certs exist"; exit 0; }
cat > ca.cnf <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Fermata Dev CA
[ext]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
CNF
cat > leaf.cnf <<CNF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = vendor.fermata.test
[ext]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:vendor.fermata.test
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
CNF
openssl ecparam -name prime256v1 -genkey -noout -out ca-key.pem
openssl req -x509 -new -key ca-key.pem -sha256 -days 825 -out ca.pem -config ca.cnf
openssl ecparam -name prime256v1 -genkey -noout -out vendor-key.pem
openssl req -new -key vendor-key.pem -out vendor.csr -config leaf.cnf
openssl x509 -req -in vendor.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 825 -sha256 -out vendor.pem -extfile leaf.cnf -extensions ext
rm -f vendor.csr ca.cnf leaf.cnf
openssl x509 -in vendor.pem -noout -subject -ext subjectAltName
echo "certs generated"
