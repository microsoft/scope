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
COPY apps/scheduler/package.json ./apps/scheduler/

RUN pnpm install --frozen-lockfile

COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src/
RUN pnpm --filter shared build

COPY packages/telemetry/tsconfig.json ./packages/telemetry/
COPY packages/telemetry/src ./packages/telemetry/src/
RUN pnpm --filter telemetry build

COPY apps/scheduler/tsconfig.json ./apps/scheduler/
COPY apps/scheduler/src ./apps/scheduler/src/

RUN pnpm --filter scheduler build

# --- Dev stage: hot reload with tsx watch ---
FROM builder AS dev
ENV NODE_ENV=development
ENV SERVICE_DIR=scheduler
COPY scripts/dev-entrypoint.sh /app/scripts/dev-entrypoint.sh
EXPOSE 8080
ENV PORT=8080
CMD ["/app/scripts/dev-entrypoint.sh"]

# --- Production stage ---
FROM node:22.22.0-slim

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
COPY apps/scheduler/package.json ./apps/scheduler/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist/
COPY --from=builder /app/packages/telemetry/dist ./packages/telemetry/dist/
COPY --from=builder /app/apps/scheduler/dist ./apps/scheduler/dist/

WORKDIR /app/apps/scheduler

EXPOSE 8080
ENV PORT=8080

CMD ["node", "--import", "telemetry/register", "dist/index.js"]
