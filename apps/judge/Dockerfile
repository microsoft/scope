FROM node:22.22.0-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY nx.json ./
COPY packages/agent-protocol/package.json ./packages/agent-protocol/
COPY packages/core/package.json ./packages/core/
COPY packages/criteria/package.json ./packages/criteria/
COPY packages/platform/package.json ./packages/platform/
COPY packages/secrets/package.json ./packages/secrets/
COPY packages/worker-runtime/package.json ./packages/worker-runtime/
COPY apps/judge/package.json ./apps/judge/

RUN pnpm install --frozen-lockfile

COPY packages/core/tsconfig.json ./packages/core/
COPY packages/core/src ./packages/core/src/
COPY packages/secrets/tsconfig.json ./packages/secrets/
COPY packages/secrets/src ./packages/secrets/src/
COPY packages/platform/tsconfig.json ./packages/platform/
COPY packages/platform/src ./packages/platform/src/
COPY packages/criteria/tsconfig.json ./packages/criteria/
COPY packages/criteria/src ./packages/criteria/src/
COPY packages/agent-protocol/tsconfig.json ./packages/agent-protocol/
COPY packages/agent-protocol/src ./packages/agent-protocol/src/
COPY packages/worker-runtime/tsconfig.json ./packages/worker-runtime/
COPY packages/worker-runtime/src ./packages/worker-runtime/src/
COPY apps/judge/tsconfig.json ./apps/judge/
COPY apps/judge/src ./apps/judge/src/

RUN npx nx run-many --target=build --projects=judge

# --- Dev stage: hot reload with tsx watch ---
FROM builder AS dev
ENV NODE_ENV=development
ENV SERVICE_DIR=judge
COPY scripts/dev-entrypoint.sh /app/scripts/dev-entrypoint.sh
COPY config /app/config/
EXPOSE 80
ENV PORT=80
CMD ["/app/scripts/dev-entrypoint.sh"]

# --- Production stage ---
FROM node:22.22.0-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/agent-protocol/package.json ./packages/agent-protocol/
COPY packages/core/package.json ./packages/core/
COPY packages/criteria/package.json ./packages/criteria/
COPY packages/platform/package.json ./packages/platform/
COPY packages/secrets/package.json ./packages/secrets/
COPY packages/worker-runtime/package.json ./packages/worker-runtime/
COPY apps/judge/package.json ./apps/judge/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/agent-protocol/dist ./packages/agent-protocol/dist/
COPY --from=builder /app/packages/core/dist ./packages/core/dist/
COPY --from=builder /app/packages/criteria/dist ./packages/criteria/dist/
COPY --from=builder /app/packages/platform/dist ./packages/platform/dist/
COPY --from=builder /app/packages/secrets/dist ./packages/secrets/dist/
COPY --from=builder /app/packages/worker-runtime/dist ./packages/worker-runtime/dist/
COPY --from=builder /app/apps/judge/dist ./apps/judge/dist/

# NOTE: Criteria are loaded at runtime via CRITERIA_API_URL (REST API) or
# CRITERIA_DIR (filesystem fallback). No need to bake criteria into the image.

WORKDIR /app/apps/judge

EXPOSE 80

ENV PORT=80
# In production, set CRITERIA_API_URL to use REST API provider.
# CRITERIA_DIR is kept as fallback for local dev with mounted criteria.
ENV CRITERIA_DIR=/app/config/criteria
ENV JUDGE_STRATEGY=bundled
ENV JUDGE_MAX_PARALLELISM=3
ENV FEEDBACK_MAX_CRITERIA=1
ENV FEEDBACK_DESCENDANT_GUARD=true

CMD ["node", "dist/index.js"]
