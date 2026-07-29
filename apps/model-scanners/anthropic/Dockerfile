FROM node:22.22.0-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY nx.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/secrets/package.json ./packages/secrets/
COPY packages/model-scanning/package.json ./packages/model-scanning/
COPY apps/model-scanners/anthropic/package.json ./apps/model-scanners/anthropic/

RUN pnpm install --frozen-lockfile

COPY packages/core/tsconfig.json ./packages/core/
COPY packages/core/src ./packages/core/src/
COPY packages/secrets/tsconfig.json ./packages/secrets/
COPY packages/secrets/src ./packages/secrets/src/
COPY packages/model-scanning/tsconfig.json ./packages/model-scanning/
COPY packages/model-scanning/src ./packages/model-scanning/src/
COPY apps/model-scanners/anthropic/tsconfig.json ./apps/model-scanners/anthropic/
COPY apps/model-scanners/anthropic/src ./apps/model-scanners/anthropic/src/

RUN npx nx run-many --target=build --projects=model-scanner-anthropic

# --- Production stage ---
FROM node:22.22.0-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/secrets/package.json ./packages/secrets/
COPY packages/model-scanning/package.json ./packages/model-scanning/
COPY apps/model-scanners/anthropic/package.json ./apps/model-scanners/anthropic/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/core/dist ./packages/core/dist/
COPY --from=builder /app/packages/secrets/dist ./packages/secrets/dist/
COPY --from=builder /app/packages/model-scanning/dist ./packages/model-scanning/dist/
COPY --from=builder /app/apps/model-scanners/anthropic/dist ./apps/model-scanners/anthropic/dist/

WORKDIR /app/apps/model-scanners/anthropic

CMD ["node", "dist/index.js"]
