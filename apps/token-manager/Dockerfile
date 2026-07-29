FROM node:22.22.0-slim AS pruner
RUN corepack enable && corepack prepare pnpm@10.29.1 --activate
WORKDIR /app
COPY . .
RUN npx turbo prune token-manager --docker

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
RUN pnpm run build --filter=token-manager...

# --- Dev stage: hot reload with tsx watch ---
FROM builder AS dev
ENV NODE_ENV=development
ENV SERVICE_DIR=token-manager
COPY scripts/dev-entrypoint.sh /app/scripts/dev-entrypoint.sh
EXPOSE 80
ENV PORT=80
CMD ["/app/scripts/dev-entrypoint.sh"]

# --- Production stage ---
FROM node:22.22.0-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/core/dist ./packages/core/dist/
COPY --from=builder /app/packages/secrets/dist ./packages/secrets/dist/
COPY --from=builder /app/apps/token-manager/dist ./apps/token-manager/dist/

WORKDIR /app/apps/token-manager

EXPOSE 80

ENV PORT=80
ENV VALIDATION_INTERVAL_MS=300000

CMD ["node", "dist/index.js"]
