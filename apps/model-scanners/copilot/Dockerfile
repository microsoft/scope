FROM node:22.22.0-slim AS pruner
RUN corepack enable && corepack prepare pnpm@10.29.1 --activate
WORKDIR /app
COPY . .
RUN npx turbo prune model-scanner-copilot --docker

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
RUN pnpm run build --filter=model-scanner-copilot...

# --- Production stage ---
FROM node:22.22.0-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/core/dist ./packages/core/dist/
COPY --from=builder /app/packages/secrets/dist ./packages/secrets/dist/
COPY --from=builder /app/packages/model-scanning/dist ./packages/model-scanning/dist/
COPY --from=builder /app/apps/model-scanners/copilot/dist ./apps/model-scanners/copilot/dist/

WORKDIR /app/apps/model-scanners/copilot

CMD ["node", "dist/index.js"]
