# syntax=docker/dockerfile:1.7
#
# Dependency builds are isolated via cargo-chef so they live in a regular image
# layer (keyed only on Cargo.toml/Cargo.lock via recipe.json). That layer is
# preserved by the GitHub Actions Docker layer cache (`cache-to: type=gha`),
# whereas BuildKit `--mount=type=cache` mounts are NOT exported to GHA cache and
# therefore caused every CI build to recompile every crate from scratch.

FROM rust:1.88-alpine AS chef
RUN apk add --no-cache musl-dev && cargo install cargo-chef --locked --version 0.1.68
WORKDIR /build

# Planner stage — produces a recipe.json describing the dependency graph.
# Source changes invalidate this stage, but recipe.json content only changes
# when Cargo.toml / Cargo.lock change, so the cook stage stays cached.
FROM chef AS planner
COPY Cargo.toml Cargo.lock* ./
# vendor/ holds the patched http-types (see [patch.crates-io] in Cargo.toml);
# it must be present so Cargo can resolve the path patch when preparing the recipe.
COPY vendor/ vendor/
COPY src/ src/
RUN cargo chef prepare --recipe-path recipe.json

# Builder stage — cook deps first (cached layer), then build the app.
FROM chef AS builder
COPY --from=planner /build/recipe.json recipe.json
# The patched http-types lives under vendor/ and is referenced by recipe.json
# as a path dependency, so cargo-chef needs it present to cook dependencies.
COPY vendor/ vendor/
# Cook compiles dependencies only. Output lives in the image layer (no cache
# mounts) so it is reused across CI runs as long as recipe.json is unchanged.
RUN cargo chef cook --release --recipe-path recipe.json
# Now bring in the real sources and build the actual binary. Deps are reused
# from the cook layer; only gateway's own crate is recompiled.
COPY Cargo.toml Cargo.lock* ./
COPY vendor/ vendor/
COPY src/ src/
RUN cargo build --release && \
    cp target/release/gateway /usr/local/bin/gateway

# Dev stage: cargo-watch for hot reload (used by docker-compose.dev.yml)
FROM rust:1.88-alpine AS dev
RUN apk add --no-cache musl-dev wget && cargo install cargo-watch --locked
WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY vendor/ vendor/
COPY src/ src/
COPY config/ config/
EXPOSE 18000 18897
CMD ["cargo", "watch", "-x", "run -- --config /build/config/default.yaml --port 18000 --api-port 18897 --cert-dir /tmp/scope-gateway/certs"]

# Runtime stage — minimal image with just the binary
FROM alpine:3.21 AS runtime
RUN apk add --no-cache ca-certificates wget
COPY --from=builder /usr/local/bin/gateway /usr/local/bin/gateway
COPY config/default.yaml /config/default.yaml
EXPOSE 18000 18897
ENTRYPOINT ["gateway"]
CMD ["--config", "/config/default.yaml"]
