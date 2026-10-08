FROM node:22.22.0-slim

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
ENV npm_config_registry=${NPM_CONFIG_REGISTRY} \
    COREPACK_NPM_REGISTRY=${NPM_CONFIG_REGISTRY}
# corepack bootstraps pnpm from the registry's per-version metadata endpoint,
# which some private registry proxies don't serve; fall back to a pinned global
# install (honors npm_config_registry) so restricted networks can still build.
RUN corepack enable && (corepack prepare pnpm@10.29.1 --activate || npm install -g pnpm@10.29.1 --force)
WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY packages/db-migrations/package.json ./packages/db-migrations/

# Install dependencies (production + dev for tsx)
RUN pnpm install --frozen-lockfile --filter db-migrations

# Copy migration source files
COPY packages/db-migrations/tsconfig.json ./packages/db-migrations/
COPY packages/db-migrations/src ./packages/db-migrations/src/

# Force rebuild to pick up migration 016 in prod ACR (see PR #706)
LABEL scope-mt.rebuild-trigger="2026-04-28"

WORKDIR /app/packages/db-migrations

CMD ["npx", "tsx", "src/migrate.ts", "up"]
