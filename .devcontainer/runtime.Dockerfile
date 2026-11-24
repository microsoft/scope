FROM node:22.22.0-bookworm@sha256:20a424ecd1d2064a44e12fe287bf3dae443aab31dc5e0c0cb6c74bef9c78911c
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates python3 openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g "$(node -p 'require("./package.json").packageManager')"
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm -r --filter './packages/**' --if-present build \
    && pnpm --dir website install --frozen-lockfile
RUN pnpm --filter github-auth exec playwright install --with-deps chromium \
    && pnpm --filter github-cookie-updater exec playwright install chromium \
    && pnpm --dir website exec playwright install chromium
ENV NODE_ENV=development
CMD ["pnpm", "exec", "vitest", "run"]