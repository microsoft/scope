FROM node:22.22.0-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY nx.json ./
COPY packages/agent-protocol/package.json ./packages/agent-protocol/
COPY packages/core/package.json ./packages/core/
COPY packages/db-migrations/package.json ./packages/db-migrations/
COPY packages/platform/package.json ./packages/platform/
COPY packages/secrets/package.json ./packages/secrets/
COPY packages/worker-runtime/package.json ./packages/worker-runtime/
COPY apps/api/package.json ./apps/api/

RUN pnpm install --frozen-lockfile

COPY packages/core/tsconfig.json ./packages/core/
COPY packages/core/src ./packages/core/src/
COPY packages/secrets/tsconfig.json ./packages/secrets/
COPY packages/secrets/src ./packages/secrets/src/
COPY packages/platform/tsconfig.json ./packages/platform/
COPY packages/platform/src ./packages/platform/src/
COPY packages/agent-protocol/tsconfig.json ./packages/agent-protocol/
COPY packages/agent-protocol/src ./packages/agent-protocol/src/
COPY packages/worker-runtime/tsconfig.json ./packages/worker-runtime/
COPY packages/worker-runtime/src ./packages/worker-runtime/src/
COPY packages/db-migrations/tsconfig.json ./packages/db-migrations/
COPY packages/db-migrations/src ./packages/db-migrations/src/
COPY apps/api/tsconfig.json ./apps/api/
COPY apps/api/src ./apps/api/src/

RUN npx nx run-many --target=build --projects=api

# --- Dev stage: hot reload with tsx watch ---
FROM builder AS dev
ENV NODE_ENV=development
ENV SERVICE_DIR=api
COPY scripts/dev-entrypoint.sh /app/scripts/dev-entrypoint.sh
COPY config /app/config/
EXPOSE 80
ENV PORT=80
CMD ["/app/scripts/dev-entrypoint.sh"]

# --- Production stage ---
FROM node:22.22.0-slim

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/agent-protocol/package.json ./packages/agent-protocol/
COPY packages/core/package.json ./packages/core/
COPY packages/db-migrations/package.json ./packages/db-migrations/
COPY packages/platform/package.json ./packages/platform/
COPY packages/secrets/package.json ./packages/secrets/
COPY packages/worker-runtime/package.json ./packages/worker-runtime/
COPY apps/api/package.json ./apps/api/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/agent-protocol/dist ./packages/agent-protocol/dist/
COPY --from=builder /app/packages/core/dist ./packages/core/dist/
COPY --from=builder /app/packages/db-migrations/dist ./packages/db-migrations/dist/
COPY --from=builder /app/packages/platform/dist ./packages/platform/dist/
COPY --from=builder /app/packages/secrets/dist ./packages/secrets/dist/
COPY --from=builder /app/packages/worker-runtime/dist ./packages/worker-runtime/dist/
COPY --from=builder /app/apps/api/dist ./apps/api/dist/

WORKDIR /app/apps/api

# Version information (passed as build args)
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_TIME=$BUILD_TIME

EXPOSE 80

ENV PORT=80

CMD ["node", "dist/index.js"]
# Optimized: uses nx run-many for parallel builds
