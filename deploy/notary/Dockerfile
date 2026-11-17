# A Fermata notary, for an operator other than the gateway's (deploy/notary/README.md).
# Build from the repository root:  docker build -f deploy/notary/Dockerfile -t fermata-notary .
FROM rust:1.95-bookworm AS build
WORKDIR /src
COPY apps/attestor ./
ENV CARGO_NET_GIT_FETCH_WITH_CLI=true
RUN cargo build --release --locked && cp target/release/fermata-attest /fermata-attest

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* && useradd --system --home /var/lib/notary notary
COPY --from=build /fermata-attest /usr/local/bin/fermata-attest
COPY deploy/notary/entrypoint.sh /usr/local/bin/notary-entrypoint
USER notary
EXPOSE 7347
ENTRYPOINT ["/usr/local/bin/notary-entrypoint"]
