# Shared Portal dependency layer
FROM node:20-alpine AS deps
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
ENV npm_config_registry=${NPM_CONFIG_REGISTRY} \
    COREPACK_NPM_REGISTRY=${NPM_CONFIG_REGISTRY}
# corepack bootstraps pnpm from the registry's per-version metadata endpoint,
# which some private registry proxies don't serve; fall back to a pinned global
# install (honors npm_config_registry) so restricted networks can still build.
RUN corepack enable && (corepack prepare pnpm@10.29.1 --activate || npm install -g pnpm@10.29.1 --force)
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/portal/package.json apps/portal/
RUN pnpm install --frozen-lockfile --filter portal --prod=false

# --- Dev stage: Vite dev server with HMR ---
# Built from `deps` (not `builder`) so the dev image skips the production build.
FROM deps AS dev
ENV NODE_ENV=development
COPY apps/portal/ apps/portal/
WORKDIR /app/apps/portal
EXPOSE 80
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "80"]

# Stage 1: Build
FROM deps AS builder
# Version information (passed as build args, used by Vite at build time)
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
ARG GIT_BRANCH=unknown
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_TIME=$BUILD_TIME
ENV GIT_BRANCH=$GIT_BRANCH

COPY apps/portal/ apps/portal/
# Public MSAL settings are available to Vite only while building the bundle.
# The nginx runtime receives neither these variables nor any client secret.
ARG VITE_AUTH_CLIENT_ID
ARG VITE_AUTH_AUTHORITY
ARG VITE_AUTH_KNOWN_AUTHORITIES
ARG VITE_AUTH_SCOPES
ARG VITE_AUTH_PROTOCOL_MODE
ARG VITE_AUTH_REDIRECT_URI
ARG VITE_AUTH_POST_LOGOUT_REDIRECT_URI
ARG VITE_AUTH_CACHE_LOCATION
RUN pnpm --filter portal build

# Stage 2: Serve with nginx
FROM nginx:alpine
COPY --from=builder /app/apps/portal/dist /usr/share/nginx/html
COPY apps/portal/nginx.conf /etc/nginx/conf.d/default.conf
# Runtime config generator — the stock nginx entrypoint runs scripts in
# /docker-entrypoint.d/ before starting nginx, so config.js reflects the
# environment's SCOPE_DOCS_BASE_URL on every container start.
COPY apps/portal/docker-entrypoint.sh /docker-entrypoint.d/99-scope-config.sh
RUN chmod +x /docker-entrypoint.d/99-scope-config.sh
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
