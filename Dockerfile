# Fermata hosted demo: the whole stack in one container (mock vendors, notary, attestor, gateway and
# dashboard), started by scripts/demo-stack.sh in public mode against Tempo Moderato. Railway builds
# this (railway.json); any Docker host works the same way. Keys come from the environment, never
# from the image, and calls, proofs and onboarded vendors persist in FERMATA_STATE_DIR (a volume).

# --- 1. fermata-attest (Rust, TLSNotary). The slow stage: several minutes.
FROM rust:1.95-bookworm AS attestor
WORKDIR /src
COPY apps/attestor ./
ENV CARGO_NET_GIT_FETCH_WITH_CLI=true
RUN cargo build --release --locked && cp target/release/fermata-attest /fermata-attest

# --- 2. Node: workspace dependencies, dashboard, dev certificates for the mock vendors.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates curl jq openssl procps \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/gateway/package.json apps/gateway/
COPY apps/mcp/package.json apps/mcp/
COPY apps/vendor/package.json apps/vendor/
COPY packages/sdk/package.json packages/sdk/
RUN corepack prepare pnpm@10.33.0 --activate && pnpm install --frozen-lockfile
COPY . .
RUN pnpm -F @fermata/dashboard build && bash apps/vendor/gen-certs.sh
COPY --from=attestor /fermata-attest /usr/local/bin/fermata-attest

ENV FERMATA_ATTEST_BIN=/usr/local/bin/fermata-attest \
    PUBLIC=1 \
    GATEWAY_HOST=0.0.0.0 \
    GATEWAY_TRUST_PROXY=2 \
    FERMATA_STATE_DIR=/data/state \
    REAL_VENDORS=npm
# Railway sets PORT; the gateway is the only process listening beyond localhost. GATEWAY_TRUST_PROXY=2:
# Railway's edge appends the visitor's address and then its own hop to X-Forwarded-For.
CMD ["bash", "-c", "GATEWAY_PORT=${PORT:-4300} exec bash scripts/demo-stack.sh run --chain moderato"]
