#!/usr/bin/env bash
# Fermata hosted demo — configure, fund and start (after deploy/install.sh), run as root:
#
#   sudo bash /opt/fermata/deploy/bootstrap.sh fermata.example.com   # a domain pointing at this VM
#   sudo bash /opt/fermata/deploy/bootstrap.sh auto                  # <public-ip>.sslip.io, no DNS needed
#
# Sets the public host name, tops up the testnet keys from the faucet, writes the Caddy site (automatic
# HTTPS), starts fermata.service + caddy, waits for the gateway and runs deploy/smoke.sh.
set -euo pipefail
DIR=/opt/fermata
DOMAIN=${1:?usage: bootstrap.sh <domain|auto>}
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
[ -f "$DIR/.env" ] || { echo "no $DIR/.env: copy your Moderato .env there, or run pnpm keys:init as fermata (see install.sh)" >&2; exit 1; }
chown fermata: "$DIR/.env" && chmod 600 "$DIR/.env"

if [ "$DOMAIN" = auto ]; then
  IP=$(curl -fsS https://api.ipify.org)
  DOMAIN="$(echo "$IP" | tr . -).sslip.io"
fi
echo "== host name: $DOMAIN"
ENV=/etc/fermata/fermata.env
set_env() { if grep -q "^$1=" "$ENV"; then sed -i "s|^$1=.*|$1=$2|" "$ENV"; else echo "$1=$2" >> "$ENV"; fi; }
set_env GATEWAY_REALM "$DOMAIN"
set_env FERMATA_DOMAIN "$DOMAIN"

echo "== testnet faucet"
sudo -u fermata -H bash -lc "cd $DIR && pnpm -s fund --chain moderato" || echo "warning: some keys were not funded; the demo turns read-only if the demo agent or relayer runs dry" >&2

echo "== caddy (automatic HTTPS for $DOMAIN)"
sed "s|{\$FERMATA_DOMAIN}|$DOMAIN|" "$DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > /dev/null
systemctl enable -q caddy && systemctl reload-or-restart caddy

echo "== fermata.service"
systemctl enable -q fermata && systemctl restart fermata
echo -n "waiting for the gateway (first start registers the services on Moderato)"
for _ in $(seq 180); do
  curl -fs -o /dev/null http://127.0.0.1:4300/info && break
  echo -n .
  sleep 5
done
echo
curl -fs -o /dev/null http://127.0.0.1:4300/info || { echo "the gateway did not come up: journalctl -u fermata -n 100" >&2; exit 1; }

bash "$DIR/deploy/smoke.sh" "https://$DOMAIN"
echo "Live: https://$DOMAIN/dashboard/"
