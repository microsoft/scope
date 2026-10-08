FROM node:22.22.0-slim AS builder

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
COPY packages/model-scanning/package.json ./packages/model-scanning/
COPY apps/model-scanners/copilot/package.json ./apps/model-scanners/copilot/

RUN pnpm install --frozen-lockfile

COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src/
COPY packages/telemetry/tsconfig.json ./packages/telemetry/
COPY packages/telemetry/src ./packages/telemetry/src/
COPY packages/model-scanning/tsconfig.json ./packages/model-scanning/
COPY packages/model-scanning/src ./packages/model-scanning/src/
COPY apps/model-scanners/copilot/tsconfig.json ./apps/model-scanners/copilot/
COPY apps/model-scanners/copilot/src ./apps/model-scanners/copilot/src/

RUN pnpm --filter shared build && pnpm --filter telemetry build && pnpm --filter model-scanning build && pnpm --filter model-scanner-copilot build

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
COPY packages/model-scanning/package.json ./packages/model-scanning/
COPY apps/model-scanners/copilot/package.json ./apps/model-scanners/copilot/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist/
COPY --from=builder /app/packages/telemetry/dist ./packages/telemetry/dist/
COPY --from=builder /app/packages/model-scanning/dist ./packages/model-scanning/dist/
COPY --from=builder /app/apps/model-scanners/copilot/dist ./apps/model-scanners/copilot/dist/

WORKDIR /app/apps/model-scanners/copilot

CMD ["node", "--import", "telemetry/register", "dist/index.js"]
