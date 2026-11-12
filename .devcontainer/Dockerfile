FROM node:22.22.0-bookworm@sha256:20a424ecd1d2064a44e12fe287bf3dae443aab31dc5e0c0cb6c74bef9c78911c

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git git-lfs sudo openssl mkcert libnss3-tools iptables jq \
    build-essential pkg-config libssl-dev cmake clang lldb libclang-dev \
    python3 python3-venv python3-pip xz-utils unzip chromium xvfb x11vnc novnc websockify \
    && rm -rf /var/lib/apt/lists/* \
    && git lfs install --system --skip-repo \
    && printf 'node ALL=(root) NOPASSWD:ALL\n' > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node

ARG TARGETARCH
RUN set -eu; \
    case "$TARGETARCH" in amd64|arm64) ;; *) echo "Unsupported architecture: $TARGETARCH"; exit 1 ;; esac; \
    curl -fsSLo /tmp/kind "https://kind.sigs.k8s.io/dl/v0.27.0/kind-linux-${TARGETARCH}"; \
    curl -fsSLo /tmp/kind.sha256 "https://kind.sigs.k8s.io/dl/v0.27.0/kind-linux-${TARGETARCH}.sha256sum"; \
    cd /tmp; sed "s/kind-linux-${TARGETARCH}/kind/" kind.sha256 | sha256sum -c -; \
    install -m 0755 kind /usr/local/bin/kind; \
    curl -fsSLo kubectl "https://dl.k8s.io/release/v1.32.2/bin/linux/${TARGETARCH}/kubectl"; \
    curl -fsSLo kubectl.sha256 "https://dl.k8s.io/release/v1.32.2/bin/linux/${TARGETARCH}/kubectl.sha256"; \
    printf '%s  kubectl\n' "$(cat kubectl.sha256)" | sha256sum -c -; \
    install -m 0755 kubectl /usr/local/bin/kubectl; \
    rm -f /tmp/kind /tmp/kind.sha256 /tmp/kubectl /tmp/kubectl.sha256

ARG COMPOSE_VERSION=v2.35.1
ARG BUILDX_VERSION=v0.22.0
RUN set -eu; \
    case "$TARGETARCH" in amd64) compose_arch=x86_64 ;; arm64) compose_arch=aarch64 ;; esac; \
    mkdir -p /usr/local/lib/docker/cli-plugins; \
    cd /tmp; \
    curl -fsSLO "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${compose_arch}"; \
    curl -fsSLO "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/checksums.txt"; \
    grep "docker-compose-linux-${compose_arch}$" checksums.txt | sha256sum -c -; \
    install -m 0755 "docker-compose-linux-${compose_arch}" /usr/local/lib/docker/cli-plugins/docker-compose; \
    curl -fsSLO "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-${TARGETARCH}"; \
    curl -fsSLo buildx-checksums.txt "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/checksums.txt"; \
    grep "buildx-${BUILDX_VERSION}.linux-${TARGETARCH}$" buildx-checksums.txt | sha256sum -c -; \
    install -m 0755 "buildx-${BUILDX_VERSION}.linux-${TARGETARCH}" /usr/local/lib/docker/cli-plugins/docker-buildx; \
    rm -f /tmp/docker-compose-linux-* /tmp/buildx-* /tmp/checksums.txt

COPY package.json /tmp/scope-package.json
RUN npm install -g "$(node -p 'require("/tmp/scope-package.json").packageManager')" \
    && rm /tmp/scope-package.json

COPY .devcontainer/install-tools.sh /tmp/install-tools.sh
RUN bash /tmp/install-tools.sh "$TARGETARCH" && rm /tmp/install-tools.sh
ENV PATH="/opt/cargo/bin:${PATH}" RUSTUP_HOME=/opt/rustup

USER node