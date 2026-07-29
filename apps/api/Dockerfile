FROM node:22.22.0-slim AS pruner
RUN corepack enable && corepack prepare pnpm@10.29.1 --activate
WORKDIR /app
COPY . .
RUN npx turbo prune api --docker

FROM node:22.22.0-slim AS installer
RUN corepack enable && corepack prepare pnpm@10.29.1 --activate
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

FROM node:22.22.0-slim AS builder
RUN corepack enable && corepack prepare pnpm@10.29.1 --activate
WORKDIR /app
COPY --from=installer /app/ .
COPY --from=pruner /app/out/full/ .
COPY tsconfig.base.json ./
RUN pnpm run build --filter=api...

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

COPY --from=pruner /app/out/json/ .
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
