FROM node:22.22.0-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY nx.json ./
COPY packages/agent-protocol/package.json ./packages/agent-protocol/
COPY packages/core/package.json ./packages/core/
COPY packages/platform/package.json ./packages/platform/
COPY packages/secrets/package.json ./packages/secrets/
COPY packages/worker-runtime/package.json ./packages/worker-runtime/
COPY apps/workers/report-generator/package.json ./apps/workers/report-generator/

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
COPY apps/workers/report-generator/tsconfig.json ./apps/workers/report-generator/
COPY apps/workers/report-generator/src ./apps/workers/report-generator/src/

RUN npx nx run-many --target=build --projects=report-generator

# --- Dev stage: hot reload with tsx watch ---
FROM builder AS dev
ENV NODE_ENV=development
ENV SERVICE_DIR=workers/report-generator
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
COPY packages/platform/package.json ./packages/platform/
COPY packages/secrets/package.json ./packages/secrets/
COPY packages/worker-runtime/package.json ./packages/worker-runtime/
COPY apps/workers/report-generator/package.json ./apps/workers/report-generator/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/agent-protocol/dist ./packages/agent-protocol/dist/
COPY --from=builder /app/packages/core/dist ./packages/core/dist/
COPY --from=builder /app/packages/platform/dist ./packages/platform/dist/
COPY --from=builder /app/packages/secrets/dist ./packages/secrets/dist/
COPY --from=builder /app/packages/worker-runtime/dist ./packages/worker-runtime/dist/
COPY --from=builder /app/apps/workers/report-generator/dist ./apps/workers/report-generator/dist/

WORKDIR /app/apps/workers/report-generator

CMD ["node", "dist/index.js"]
