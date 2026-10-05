#!/usr/bin/env bash
# Fermata hosted demo — one-time install on a fresh Ubuntu 24.04 VM (4 vCPU / 8 GB), run as root:
#
#   curl -fsSL https://raw.githubusercontent.com/bilgin-kocak/fermata/main/deploy/install.sh | sudo bash
#   (or: sudo bash deploy/install.sh from a checkout)
#
# Installs Node 22 + pnpm, Rust 1.95 (for the attestor), jq, openssl and Caddy; clones the repo to
# /opt/fermata; builds the attestor and the dashboard; installs the systemd unit. Idempotent: re-run
# it to update. Keys and settings are NOT created here: next step is deploy/bootstrap.sh.
set -euo pipefail
REPO=${FERMATA_REPO:-https://github.com/bilgin-kocak/fermata}
BRANCH=${FERMATA_BRANCH:-main}
DIR=/opt/fermata
USER_HOME=/var/lib/fermata
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
. /etc/os-release
[ "${ID:-}" = ubuntu ] || echo "warning: tested on Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}" >&2

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl git jq openssl ca-certificates build-essential pkg-config gnupg debian-keyring debian-archive-keyring apt-transport-https
if ! command -v node > /dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
corepack enable
if ! command -v caddy > /dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

echo "== user and checkout"
id fermata > /dev/null 2>&1 || useradd --system --create-home --home-dir "$USER_HOME" --shell /bin/bash fermata
if [ -d "$DIR/.git" ]; then
  # The checkout belongs to fermata: update it as fermata (root's git refuses another user's repo),
  # one command per line so set -e stops on any failure instead of silently keeping the old code.
  sudo -u fermata -H git -C "$DIR" fetch -q origin "$BRANCH"
  sudo -u fermata -H git -C "$DIR" checkout -q "$BRANCH"
  sudo -u fermata -H git -C "$DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO" "$DIR"
fi
chown -R fermata: "$DIR"
install -d -m 750 -o fermata -g fermata "$USER_HOME/state"

echo "== toolchains and build (the attestor takes several minutes the first time)"
sudo -u fermata -H bash -lc '
  set -euo pipefail
  command -v rustup > /dev/null || curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.95.0
  . "$HOME/.cargo/env"
  rustup toolchain install 1.95.0 --profile minimal > /dev/null
  cd /opt/fermata
  corepack prepare pnpm@10.33.0 --activate > /dev/null
  git submodule update --init -q
  pnpm install --frozen-lockfile
  (cd apps/attestor && CARGO_NET_GIT_FETCH_WITH_CLI=true cargo +1.95.0 build --release)
  pnpm -F @fermata/dashboard build
  [ -f apps/vendor/certs/ca.pem ] || (cd apps/vendor && bash gen-certs.sh)
'

echo "== service"
install -d -m 750 -o fermata -g fermata /etc/fermata
[ -f /etc/fermata/fermata.env ] || install -m 600 -o fermata -g fermata "$DIR/deploy/fermata.env.example" /etc/fermata/fermata.env
install -m 644 "$DIR/deploy/fermata.service" /etc/systemd/system/fermata.service
systemctl daemon-reload

cat <<EOF

Installed. Next:
  1. Keys: create fresh testnet keys for this server (recommended: a gateway sharing your laptop's
     relayer key races it for nonces): sudo -u fermata -H bash -lc 'cd $DIR && pnpm keys:init'
  2. sudo bash $DIR/deploy/bootstrap.sh <your-domain | auto>     (auto = <ip>.sslip.io)
EOF
