FROM node:22.22.0-slim AS pruner
RUN corepack enable && corepack prepare pnpm@10.29.1 --activate
WORKDIR /app
COPY . .
RUN npx turbo prune judge --docker

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
RUN pnpm run build --filter=judge...

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

COPY --from=pruner /app/out/json/ .
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
