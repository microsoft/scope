FROM node:22.22.0-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/workers/taxonomy/package.json ./apps/workers/taxonomy/

RUN pnpm install --frozen-lockfile

COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src/
COPY apps/workers/taxonomy/tsconfig.json ./apps/workers/taxonomy/
COPY apps/workers/taxonomy/src ./apps/workers/taxonomy/src/
COPY apps/workers/taxonomy/handler.yaml ./apps/workers/taxonomy/

RUN pnpm --filter shared build && pnpm --filter taxonomy-handler build

# --- Dev stage: hot reload with tsx watch ---
FROM builder AS dev
ENV NODE_ENV=development
ENV SERVICE_DIR=workers/taxonomy
COPY scripts/dev-entrypoint.sh /app/scripts/dev-entrypoint.sh
EXPOSE 80
ENV PORT=80
CMD ["/app/scripts/dev-entrypoint.sh"]

# --- Production stage ---
FROM node:22.22.0-slim

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/workers/taxonomy/package.json ./apps/workers/taxonomy/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist/
COPY --from=builder /app/apps/workers/taxonomy/dist ./apps/workers/taxonomy/dist/
COPY --from=builder /app/apps/workers/taxonomy/handler.yaml ./apps/workers/taxonomy/handler.yaml

WORKDIR /app/apps/workers/taxonomy

CMD ["node", "dist/index.js"]
