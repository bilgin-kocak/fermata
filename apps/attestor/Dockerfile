# fermata-attest (notary + attestor). Build context: apps/attestor.
FROM rust:1.95-bookworm AS build
WORKDIR /src
COPY . .
ENV CARGO_NET_GIT_FETCH_WITH_CLI=true
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/fermata-attest /usr/local/bin/fermata-attest
COPY predicates /predicates
ENTRYPOINT ["fermata-attest"]
