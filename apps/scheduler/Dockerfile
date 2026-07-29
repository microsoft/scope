FROM node:22.22.0-slim AS pruner
RUN corepack enable && corepack prepare pnpm@10.29.1 --activate
WORKDIR /app
COPY . .
RUN npx turbo prune scheduler --docker

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
RUN pnpm run build --filter=scheduler...

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

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/core/dist ./packages/core/dist/
COPY --from=builder /app/apps/scheduler/dist ./apps/scheduler/dist/

WORKDIR /app/apps/scheduler

EXPOSE 8080
ENV PORT=8080

CMD ["node", "dist/index.js"]
