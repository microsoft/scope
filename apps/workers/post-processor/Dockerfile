FROM node:22.22.0-slim AS builder

# The bundled Copilot CLI trusts the OS CA store for token validation.
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
COPY packages/taxonomy-engine/package.json ./packages/taxonomy-engine/
COPY packages/ax-taxonomy/package.json ./packages/ax-taxonomy/
COPY apps/workers/post-processor/package.json ./apps/workers/post-processor/

RUN pnpm install --frozen-lockfile

COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src/
COPY packages/telemetry/tsconfig.json ./packages/telemetry/
COPY packages/telemetry/src ./packages/telemetry/src/
COPY packages/taxonomy-engine/tsconfig.json ./packages/taxonomy-engine/
COPY packages/taxonomy-engine/src ./packages/taxonomy-engine/src/
COPY packages/ax-taxonomy/tsconfig.json ./packages/ax-taxonomy/
COPY packages/ax-taxonomy/src ./packages/ax-taxonomy/src/
COPY apps/workers/post-processor/tsconfig.json ./apps/workers/post-processor/
COPY apps/workers/post-processor/src ./apps/workers/post-processor/src/
# Copy every handler manifest (handler.yaml = pp-atif, handler.taxonomy.yaml =
# pp-taxonomy, plus any future handlers). The registration jobs read these by
# HANDLER_YAML_PATH, so all must be present in the image.
COPY apps/workers/post-processor/handler*.yaml ./apps/workers/post-processor/

RUN pnpm --filter shared build \
    && pnpm --filter telemetry build \
    && pnpm --filter taxonomy-engine build \
    && pnpm --filter ax-taxonomy build \
    && pnpm --filter post-processor build

# --- Dev stage: hot reload with tsx watch ---
FROM builder AS dev
ENV NODE_ENV=development
ENV SERVICE_DIR=workers/post-processor
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
COPY packages/taxonomy-engine/package.json ./packages/taxonomy-engine/
COPY packages/ax-taxonomy/package.json ./packages/ax-taxonomy/
COPY apps/workers/post-processor/package.json ./apps/workers/post-processor/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist/
COPY --from=builder /app/packages/telemetry/dist ./packages/telemetry/dist/
COPY --from=builder /app/packages/taxonomy-engine/dist ./packages/taxonomy-engine/dist/
COPY --from=builder /app/packages/ax-taxonomy/dist ./packages/ax-taxonomy/dist/
COPY --from=builder /app/apps/workers/post-processor/dist ./apps/workers/post-processor/dist/
COPY --from=builder /app/apps/workers/post-processor/handler*.yaml ./apps/workers/post-processor/

WORKDIR /app/apps/workers/post-processor

CMD ["node", "--import", "telemetry/register", "dist/index.js"]
