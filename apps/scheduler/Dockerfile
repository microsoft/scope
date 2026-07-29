FROM node:22.22.0-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY nx.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/scheduler/package.json ./apps/scheduler/

RUN pnpm install --frozen-lockfile

COPY packages/core/tsconfig.json ./packages/core/
COPY packages/core/src ./packages/core/src/
COPY apps/scheduler/tsconfig.json ./apps/scheduler/
COPY apps/scheduler/src ./apps/scheduler/src/

RUN npx nx run-many --target=build --projects=scheduler

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

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json ./packages/core/
COPY apps/scheduler/package.json ./apps/scheduler/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/core/dist ./packages/core/dist/
COPY --from=builder /app/apps/scheduler/dist ./apps/scheduler/dist/

WORKDIR /app/apps/scheduler

EXPOSE 8080
ENV PORT=8080

CMD ["node", "dist/index.js"]
