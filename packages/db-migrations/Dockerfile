FROM node:22.22.0-slim

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
ARG COREPACK_NPM_REGISTRY=
COPY scripts/bootstrap-pnpm.sh /usr/local/bin/bootstrap-pnpm
RUN NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY}" COREPACK_NPM_REGISTRY="${COREPACK_NPM_REGISTRY}" sh /usr/local/bin/bootstrap-pnpm
WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY packages/db-migrations/package.json ./packages/db-migrations/

# Install dependencies (production + dev for tsx)
RUN NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY}" pnpm install --frozen-lockfile --filter db-migrations

# Copy migration source files
COPY packages/db-migrations/tsconfig.json ./packages/db-migrations/
COPY packages/db-migrations/src ./packages/db-migrations/src/

# Force rebuild to pick up migration 016 in prod ACR (see PR #706)
LABEL scope-mt.rebuild-trigger="2026-04-28"

WORKDIR /app/packages/db-migrations

CMD ["npx", "tsx", "src/migrate.ts", "up"]
