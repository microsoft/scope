ARG COPILOT_CLI_VERSION

# --- Base stage: runtime tools shared by dev and production ---
FROM node:24-slim AS base

RUN corepack enable && corepack prepare pnpm@10.29.1 --activate

# Install system tools for coding agents: Python, uv, git, PowerShell, Go, .NET, Rust, Java, Maven, Gradle
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    curl \
    git \
    libicu72 \
  unzip \
  rustc \
  cargo \
    && curl -LsSf https://astral.sh/uv/0.10.0/install.sh | sh \
    && ARCH=$(dpkg --print-architecture) \
  && case "$ARCH" in amd64) PS_ARCH=x64; DOTNET_ARCH=x64; JAVA_ARCH=x64;; arm64) PS_ARCH=arm64; DOTNET_ARCH=arm64; JAVA_ARCH=aarch64;; *) echo "Unsupported arch: $ARCH" && exit 1;; esac \
    && curl -fsSL -o /tmp/powershell.tar.gz \
      "https://github.com/PowerShell/PowerShell/releases/download/v7.4.14/powershell-7.4.14-linux-${PS_ARCH}.tar.gz" \
    && mkdir -p /opt/microsoft/powershell/7 \
    && tar -xzf /tmp/powershell.tar.gz -C /opt/microsoft/powershell/7 \
    && rm /tmp/powershell.tar.gz \
    && chmod +x /opt/microsoft/powershell/7/pwsh \
    && ln -s /opt/microsoft/powershell/7/pwsh /usr/local/bin/pwsh \
    && curl -fsSL -o /tmp/dotnet-sdk.tar.gz \
      "https://dotnetcli.blob.core.windows.net/dotnet/Sdk/8.0.111/dotnet-sdk-8.0.111-linux-${DOTNET_ARCH}.tar.gz" \
    && mkdir -p /opt/dotnet \
    && tar -xzf /tmp/dotnet-sdk.tar.gz -C /opt/dotnet \
    && rm /tmp/dotnet-sdk.tar.gz \
    && chmod +x /opt/dotnet/dotnet \
    && ln -s /opt/dotnet/dotnet /usr/local/bin/dotnet \
    && GO_ARCH=$(dpkg --print-architecture) \
    && curl -fsSL -o /tmp/go.tar.gz \
      "https://go.dev/dl/go1.26.3.linux-${GO_ARCH}.tar.gz" \
    && tar -C /usr/local -xzf /tmp/go.tar.gz \
    && rm /tmp/go.tar.gz \
    && ln -s /usr/local/go/bin/go /usr/local/bin/go \
    && curl -fsSL -o /tmp/java.tar.gz \
      "https://api.adoptium.net/v3/binary/version/jdk-21.0.4+7/linux/${JAVA_ARCH}/jdk/hotspot/normal/eclipse" \
    && mkdir -p /opt/java \
    && tar -xzf /tmp/java.tar.gz -C /opt/java --strip-components=1 \
    && rm /tmp/java.tar.gz \
    && chmod +x /opt/java/bin/java \
    && ln -s /opt/java/bin/java /usr/local/bin/java \
    && curl -fsSL -o /tmp/maven.tar.gz \
      "https://archive.apache.org/dist/maven/maven-3/3.9.8/binaries/apache-maven-3.9.8-bin.tar.gz" \
    && mkdir -p /opt/maven \
    && tar -xzf /tmp/maven.tar.gz -C /opt/maven --strip-components=1 \
    && rm /tmp/maven.tar.gz \
    && chmod +x /opt/maven/bin/mvn \
    && ln -s /opt/maven/bin/mvn /usr/local/bin/mvn \
    && curl -fsSL -o /tmp/gradle.zip \
      "https://services.gradle.org/distributions/gradle-8.12-bin.zip" \
    && mkdir -p /opt/gradle \
    && unzip -q /tmp/gradle.zip -d /opt/gradle \
    && rm /tmp/gradle.zip \
    && chmod +x /opt/gradle/gradle-8.12/bin/gradle \
    && ln -s /opt/gradle/gradle-8.12/bin/gradle /usr/local/bin/gradle \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.cargo/bin:/root/.local/bin:$PATH"

# --- Builder stage: compile TypeScript ---
FROM base AS builder

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY nx.json ./
COPY packages/agent-protocol/package.json ./packages/agent-protocol/
COPY packages/core/package.json ./packages/core/
COPY packages/platform/package.json ./packages/platform/
COPY packages/secrets/package.json ./packages/secrets/
COPY packages/worker-runtime/package.json ./packages/worker-runtime/
COPY apps/workers/coder-acp-copilot/package.json ./apps/workers/coder-acp-copilot/

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
COPY apps/workers/coder-acp-copilot/tsconfig.json ./apps/workers/coder-acp-copilot/
COPY apps/workers/coder-acp-copilot/src ./apps/workers/coder-acp-copilot/src/

RUN npx nx run-many --target=build --projects=coder-acp-copilot

# --- Dev stage: hot reload with tsx watch ---
FROM builder AS dev
ARG COPILOT_CLI_VERSION
RUN npm install -g @github/copilot@${COPILOT_CLI_VERSION}

# Use existing node user (UID 1000) so coding agents allow bypassPermissions mode
RUN mkdir -p /workspace && chown node:node /workspace
# Copy uv to a shared location accessible by non-root user
RUN cp -r /root/.local/bin/* /usr/local/bin/ 2>/dev/null || true

ENV NODE_ENV=development
ENV SERVICE_DIR=workers/coder-acp-copilot
ENV WORKER_NAME=coder-acp-copilot
COPY scripts/dev-entrypoint.sh /app/scripts/dev-entrypoint.sh
COPY config /app/config/
RUN chown -R node:node /app/packages/core/dist /app/packages/secrets/dist /app/packages/platform/dist /app/packages/agent-protocol/dist /app/packages/worker-runtime/dist /app/apps/workers/coder-acp-copilot/dist
USER node
CMD ["/app/scripts/dev-entrypoint.sh"]

# --- Production stage ---
FROM base

# Install GitHub Copilot CLI globally
ARG COPILOT_CLI_VERSION
RUN npm install -g @github/copilot@${COPILOT_CLI_VERSION}

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/agent-protocol/package.json ./packages/agent-protocol/
COPY packages/core/package.json ./packages/core/
COPY packages/platform/package.json ./packages/platform/
COPY packages/secrets/package.json ./packages/secrets/
COPY packages/worker-runtime/package.json ./packages/worker-runtime/
COPY apps/workers/coder-acp-copilot/package.json ./apps/workers/coder-acp-copilot/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/agent-protocol/dist ./packages/agent-protocol/dist/
COPY --from=builder /app/packages/core/dist ./packages/core/dist/
COPY --from=builder /app/packages/platform/dist ./packages/platform/dist/
COPY --from=builder /app/packages/secrets/dist ./packages/secrets/dist/
COPY --from=builder /app/packages/worker-runtime/dist ./packages/worker-runtime/dist/
COPY --from=builder /app/apps/workers/coder-acp-copilot/dist ./apps/workers/coder-acp-copilot/dist/

# Use existing node user (UID 1000) so coding agents allow bypassPermissions mode
RUN mkdir -p /workspace && chown node:node /workspace
# Copy uv to a shared location accessible by non-root user
RUN cp -r /root/.local/bin/* /usr/local/bin/ 2>/dev/null || true

WORKDIR /app/apps/workers/coder-acp-copilot

# Expose component versions + build metadata at runtime (used by self-registration)
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
ENV COPILOT_CLI_VERSION=$COPILOT_CLI_VERSION
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_TIME=$BUILD_TIME
ENV WORKER_NAME=coder-acp-copilot

USER node
CMD ["node", "dist/index.js"]
