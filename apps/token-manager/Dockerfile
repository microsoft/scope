FROM node:22.22.0-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY nx.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/secrets/package.json ./packages/secrets/
COPY apps/token-manager/package.json ./apps/token-manager/

RUN pnpm install --frozen-lockfile

COPY packages/core/tsconfig.json ./packages/core/
COPY packages/core/src ./packages/core/src/
COPY packages/secrets/tsconfig.json ./packages/secrets/
COPY packages/secrets/src ./packages/secrets/src/
COPY apps/token-manager/tsconfig.json ./apps/token-manager/
COPY apps/token-manager/src ./apps/token-manager/src/

RUN npx nx run-many --target=build --projects=token-manager

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

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/secrets/package.json ./packages/secrets/
COPY apps/token-manager/package.json ./apps/token-manager/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/core/dist ./packages/core/dist/
COPY --from=builder /app/packages/secrets/dist ./packages/secrets/dist/
COPY --from=builder /app/apps/token-manager/dist ./apps/token-manager/dist/

WORKDIR /app/apps/token-manager

EXPOSE 80

ENV PORT=80
ENV VALIDATION_INTERVAL_MS=300000

CMD ["node", "dist/index.js"]
