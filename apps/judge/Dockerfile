FROM node:22.22.0-slim AS builder

# The bundled Copilot CLI (and its Rust auto-updater) trusts the OS system CA
# store rather than Node's built-in roots, so the CA bundle must be present in
# every stage that runs the CLI — including the dev stage used by
# `docker:dev:copilot`. Without it, SDK token validation fails with an opaque
# "fetch failed" / "No CA certificates were loaded from the system".
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
ENV npm_config_registry=${NPM_CONFIG_REGISTRY} \
    COREPACK_NPM_REGISTRY=${NPM_CONFIG_REGISTRY}
# corepack bootstraps pnpm from the registry's per-version metadata endpoint,
# which some private registry proxies don't serve; fall back to a pinned global
# install (honors npm_config_registry) so restricted networks can still build.
RUN corepack enable && (corepack prepare pnpm@10.29.1 --activate || npm install -g pnpm@10.29.1 --force)
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/telemetry/package.json ./packages/telemetry/
COPY apps/judge/package.json ./apps/judge/

RUN pnpm install --frozen-lockfile

COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src/
COPY packages/telemetry/tsconfig.json ./packages/telemetry/
COPY packages/telemetry/src ./packages/telemetry/src/
COPY apps/judge/tsconfig.json ./apps/judge/
COPY apps/judge/src ./apps/judge/src/

RUN pnpm --filter shared build && pnpm --filter telemetry build && pnpm --filter judge build

# --- Dev stage: hot reload with tsx watch ---
FROM builder AS dev
ENV NODE_ENV=development
ENV SERVICE_DIR=judge
COPY scripts/dev-entrypoint.sh /app/scripts/dev-entrypoint.sh
COPY config /app/config/
EXPOSE 80
ENV PORT=80
CMD ["/app/scripts/dev-entrypoint.sh"]

# --- Production stage ---
FROM node:22.22.0-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
ENV npm_config_registry=${NPM_CONFIG_REGISTRY} \
    COREPACK_NPM_REGISTRY=${NPM_CONFIG_REGISTRY}
# corepack bootstraps pnpm from the registry's per-version metadata endpoint,
# which some private registry proxies don't serve; fall back to a pinned global
# install (honors npm_config_registry) so restricted networks can still build.
RUN corepack enable && (corepack prepare pnpm@10.29.1 --activate || npm install -g pnpm@10.29.1 --force)
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/telemetry/package.json ./packages/telemetry/
COPY apps/judge/package.json ./apps/judge/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist/
COPY --from=builder /app/packages/telemetry/dist ./packages/telemetry/dist/
COPY --from=builder /app/apps/judge/dist ./apps/judge/dist/

# NOTE: Criteria are loaded at runtime via CRITERIA_API_URL (REST API) or
# CRITERIA_DIR (filesystem fallback). No need to bake criteria into the image.

WORKDIR /app/apps/judge

EXPOSE 80

ENV PORT=80
# In production, set CRITERIA_API_URL to use REST API provider.
# CRITERIA_DIR is kept as fallback for local dev with mounted criteria.
ENV CRITERIA_DIR=/app/config/criteria
ENV JUDGE_STRATEGY=bundled
ENV JUDGE_MAX_PARALLELISM=3
ENV FEEDBACK_MAX_CRITERIA=1
ENV FEEDBACK_DESCENDANT_GUARD=true

CMD ["node", "--import", "telemetry/register", "dist/index.js"]
