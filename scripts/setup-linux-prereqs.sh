#!/usr/bin/env bash
# =============================================================================
# setup-linux-prereqs.sh — check (and optionally install) everything needed to
# develop Scope on a Linux machine with Docker.
#
# Installs / verifies:
#   - git, curl, ca-certificates, openssl, tar, unzip
#   - libnss3-tools          (required by mkcert on Linux)
#   - shasum (libdigest-sha-perl)  -> used by scripts/worktree-env.sh
#   - Node.js 22             (matches CI)
#   - corepack + pnpm 10.29.1 (pinned via package.json "packageManager")
#   - Docker Engine + Compose v2 (must support `compose watch`)
#   - mkcert                 (trusted HTTPS cert for the local auth emulator)
#   - GitHub CLI `gh`        (obtains the Copilot token for docker:dev:copilot)
#
# Usage:
#   ./scripts/setup-linux-prereqs.sh              # check + install what's missing
#   ./scripts/setup-linux-prereqs.sh --check      # report only, never install
#   ./scripts/setup-linux-prereqs.sh --skip-docker    # e.g. using Docker Desktop
#   ./scripts/setup-linux-prereqs.sh --skip-gh
#   ./scripts/setup-linux-prereqs.sh --yes        # no interactive prompts
# =============================================================================
set -uo pipefail

# --- Pinned versions (keep in sync with package.json / README) ---------------
readonly REQUIRED_NODE_MAJOR=22
readonly REQUIRED_PNPM_VERSION=10.29.1
readonly MKCERT_VERSION=v1.4.4

# --- Flags ------------------------------------------------------------------
CHECK_ONLY=0
SKIP_DOCKER=0
SKIP_GH=0
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    --check|--dry-run) CHECK_ONLY=1 ;;
    --skip-docker)     SKIP_DOCKER=1 ;;
    --skip-gh)         SKIP_GH=1 ;;
    --yes|-y)          ASSUME_YES=1 ;;
    --help|-h)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# --- Output helpers ---------------------------------------------------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'; C_BOLD=$'\033[1m'
else
  C_RESET=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; C_BOLD=''
fi

MISSING=()
WARNINGS=()

step() { printf '\n%s==> %s%s\n' "$C_CYAN$C_BOLD" "$1" "$C_RESET"; }
ok()   { printf '    %s[ok]%s   %s\n' "$C_GREEN" "$C_RESET" "$1"; }
bad()  { printf '    %s[miss]%s %s\n' "$C_RED" "$C_RESET" "$1"; MISSING+=("$1"); }
warn() { printf '    %s[warn]%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; WARNINGS+=("$1"); }
info() { printf '    %s\n' "$1"; }

have() { command -v "$1" >/dev/null 2>&1; }

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || return 0
  local reply
  read -r -p "    $1 [Y/n] " reply
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}

# --- Privilege / distro detection -------------------------------------------
# $USER is unset in containers (e.g. a devcontainer running as root) and
# `set -u` would abort on it, so resolve the account name directly.
CURRENT_USER="$(id -un)"
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if have sudo; then SUDO="sudo"; else
    warn "Not root and 'sudo' not found — installation steps will be skipped."
    CHECK_ONLY=1
  fi
fi

PKG=""
if   have apt-get; then PKG=apt
elif have dnf;     then PKG=dnf
elif have zypper;  then PKG=zypper
elif have pacman;  then PKG=pacman
fi

ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64)  ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *)             ARCH="$ARCH_RAW" ;;
esac

IS_WSL=0
grep -qi microsoft /proc/version 2>/dev/null && IS_WSL=1

pkg_install() {
  # pkg_install <apt-names> <dnf-names> <zypper-names> <pacman-names>
  [ "$CHECK_ONLY" = 1 ] && return 1
  case "$PKG" in
    apt)    $SUDO apt-get install -y $1 ;;
    dnf)    $SUDO dnf install -y $2 ;;
    zypper) $SUDO zypper install -y $3 ;;
    pacman) $SUDO pacman -S --noconfirm $4 ;;
    *)      return 1 ;;
  esac
}

APT_UPDATED=0
pkg_refresh() {
  [ "$CHECK_ONLY" = 1 ] && return 0
  case "$PKG" in
    apt) [ "$APT_UPDATED" = 0 ] && $SUDO apt-get update -y && APT_UPDATED=1 ;;
    *) : ;;
  esac
}

printf '%s\n' "${C_BOLD}Scope — Linux prerequisites${C_RESET}"
info "arch=$ARCH  package-manager=${PKG:-unknown}  wsl=$IS_WSL  check-only=$CHECK_ONLY"

# ---------------------------------------------------------------------------
# 1. Base system tools
# ---------------------------------------------------------------------------
step "Base tools (git, curl, openssl, tar, unzip, ca-certificates)"

pkg_refresh
for tool in git curl openssl tar unzip; do
  if have "$tool"; then
    ok "$tool ($("$tool" --version 2>/dev/null | head -n1))"
  else
    bad "$tool"
    pkg_install "$tool" "$tool" "$tool" "$tool" >/dev/null 2>&1 \
      && ok "$tool installed" || warn "could not install $tool automatically"
  fi
done

# bash is required: every scripts/*.sh uses `#!/usr/bin/env bash`
if have bash; then ok "bash ($(bash --version | head -n1))"; else bad "bash"; fi

# ---------------------------------------------------------------------------
# 2. libnss3-tools — mkcert's Linux trust-store dependency
#    (called out explicitly by scripts/ensure-dev-certs.sh)
# ---------------------------------------------------------------------------
step "libnss3-tools (mkcert trust store support)"

if have certutil; then
  ok "certutil present (libnss3-tools installed)"
else
  bad "libnss3-tools / nss-tools"
  pkg_install "libnss3-tools" "nss-tools" "mozilla-nss-tools" "nss" >/dev/null 2>&1 \
    && ok "nss tools installed" || warn "install nss tools manually (mkcert needs them)"
fi

# ---------------------------------------------------------------------------
# 3. shasum — used by scripts/worktree-env.sh to shorten MONGO_DATABASE
# ---------------------------------------------------------------------------
step "shasum (SHA-256 helper used by scripts/worktree-env.sh)"

if have shasum; then
  ok "shasum available"
else
  bad "shasum"
  pkg_install "libdigest-sha-perl" "perl-Digest-SHA" "perl-Digest-SHA" "perl" >/dev/null 2>&1 \
    && ok "shasum installed" || warn "install a 'shasum' provider (e.g. libdigest-sha-perl)"
fi

# ---------------------------------------------------------------------------
# 4. Node.js 22
# ---------------------------------------------------------------------------
step "Node.js ${REQUIRED_NODE_MAJOR}.x"

node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

if have node && [ "$(node_major)" = "$REQUIRED_NODE_MAJOR" ]; then
  ok "node $(node -v)"
elif have node; then
  warn "node $(node -v) found, but Scope and CI use Node ${REQUIRED_NODE_MAJOR}.x"
  if [ "$CHECK_ONLY" = 0 ] && [ "$PKG" = apt ] && confirm "Install Node ${REQUIRED_NODE_MAJOR} via NodeSource?"; then
    curl -fsSL "https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | ${SUDO:+$SUDO -E} bash - \
      && $SUDO apt-get install -y nodejs \
      && ok "node $(node -v)"
  else
    info "Tip: 'nvm install ${REQUIRED_NODE_MAJOR}' also works if you prefer a version manager."
  fi
else
  bad "node"
  if [ "$CHECK_ONLY" = 0 ] && [ "$PKG" = apt ]; then
    curl -fsSL "https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | ${SUDO:+$SUDO -E} bash - \
      && $SUDO apt-get install -y nodejs \
      && ok "node $(node -v)" || warn "install Node ${REQUIRED_NODE_MAJOR} manually"
  else
    warn "install Node ${REQUIRED_NODE_MAJOR} manually (https://nodejs.org)"
  fi
fi

# ---------------------------------------------------------------------------
# 5. corepack + pnpm (pinned to packageManager in package.json)
# ---------------------------------------------------------------------------
step "corepack + pnpm ${REQUIRED_PNPM_VERSION}"

if have corepack; then
  ok "corepack $(corepack --version 2>/dev/null)"
  if [ "$CHECK_ONLY" = 0 ]; then
    corepack enable >/dev/null 2>&1 || $SUDO corepack enable >/dev/null 2>&1 || true
    corepack prepare "pnpm@${REQUIRED_PNPM_VERSION}" --activate >/dev/null 2>&1 || true
  fi
else
  bad "corepack (ships with Node ${REQUIRED_NODE_MAJOR})"
fi

if have pnpm; then
  PNPM_V="$(pnpm --version 2>/dev/null)"
  if [ "$PNPM_V" = "$REQUIRED_PNPM_VERSION" ]; then
    ok "pnpm $PNPM_V"
  else
    warn "pnpm $PNPM_V found; repo pins $REQUIRED_PNPM_VERSION (corepack resolves this per-project)"
  fi
else
  bad "pnpm"
  warn "run: corepack enable && corepack prepare pnpm@${REQUIRED_PNPM_VERSION} --activate"
fi

# ---------------------------------------------------------------------------
# 6. Docker Engine + Compose v2 (with `compose watch`)
# ---------------------------------------------------------------------------
if [ "$SKIP_DOCKER" = 1 ]; then
  step "Docker (skipped via --skip-docker)"
else
  step "Docker Engine + Compose v2"

  if have docker; then
    ok "docker $(docker --version 2>/dev/null)"
  else
    bad "docker"
    if [ "$CHECK_ONLY" = 0 ] && confirm "Install Docker Engine via get.docker.com?"; then
      curl -fsSL https://get.docker.com -o /tmp/get-docker.sh \
        && $SUDO sh /tmp/get-docker.sh \
        && rm -f /tmp/get-docker.sh \
        && ok "docker installed" || warn "Docker install failed — install manually"
    else
      warn "install Docker Engine: https://docs.docker.com/engine/install/"
    fi
  fi

  if docker compose version >/dev/null 2>&1; then
    ok "docker compose $(docker compose version --short 2>/dev/null)"
    if docker compose watch --help >/dev/null 2>&1; then
      ok "compose watch supported (required by pnpm docker:dev:*)"
    else
      warn "this Compose v2 build lacks 'compose watch' — upgrade the compose plugin"
    fi
  else
    bad "docker compose v2 plugin"
    pkg_install "docker-compose-plugin" "docker-compose-plugin" "docker-compose-plugin" "docker-compose" >/dev/null 2>&1 \
      && ok "compose plugin installed" \
      || warn "install the Compose v2 plugin: https://docs.docker.com/compose/install/linux/"
  fi

  # Daemon reachable + rootless/group check
  if have docker; then
    if docker info >/dev/null 2>&1; then
      ok "docker daemon reachable as $(id -un)"
    else
      warn "cannot talk to the Docker daemon as $(id -un)"
      if [ "$IS_WSL" = 1 ]; then
        info "WSL: start it with  sudo service docker start   (or enable Docker Desktop WSL integration)"
      else
        info "Try:  $SUDO systemctl enable --now docker"
      fi
      if ! id -nG "$CURRENT_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
        warn "$CURRENT_USER is not in the 'docker' group"
        if [ "$CHECK_ONLY" = 0 ] && confirm "Add $CURRENT_USER to the docker group?"; then
          $SUDO groupadd -f docker && $SUDO usermod -aG docker "$CURRENT_USER" \
            && warn "group added — log out and back in (or run: newgrp docker)"
        fi
      fi
    fi
  fi

  # DOCKER_GID: docker-compose.yml passes this to the ACP workers for socket access.
  if getent group docker >/dev/null 2>&1; then
    DGID="$(getent group docker | cut -d: -f3)"
    ok "docker group GID = $DGID"
    info "Linux tip: export DOCKER_GID=$DGID so the ACP workers can use /var/run/docker.sock"
    info "(Docker Engine only: with Docker Desktop, including WSL, leave DOCKER_GID unset)"
  fi
fi

# ---------------------------------------------------------------------------
# 7. mkcert — trusted HTTPS for the local Entra emulator
# ---------------------------------------------------------------------------
step "mkcert (local HTTPS certificate authority)"

if have mkcert; then
  ok "mkcert $(mkcert -version 2>/dev/null)"
else
  bad "mkcert"
  if [ "$CHECK_ONLY" = 0 ] && confirm "Download mkcert ${MKCERT_VERSION} for linux/${ARCH}?"; then
    url="https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VERSION}/mkcert-${MKCERT_VERSION}-linux-${ARCH}"
    if curl -fsSL -o /tmp/mkcert "$url"; then
      chmod +x /tmp/mkcert && $SUDO mv /tmp/mkcert /usr/local/bin/mkcert \
        && ok "mkcert installed to /usr/local/bin/mkcert"
    else
      warn "download failed — install mkcert manually: https://github.com/FiloSottile/mkcert#installation"
    fi
  else
    warn "install mkcert: https://github.com/FiloSottile/mkcert#installation"
  fi
fi

if [ "$IS_WSL" = 1 ]; then
  warn "WSL detected: 'mkcert -install' here does NOT trust the CA in a Windows browser."
  info "After the first 'pnpm docker:dev:*', import .certs/rootCA.pem into the Windows"
  info "CurrentUser\\Root store (see ENV_VARIABLES.md -> Local dev setup (entra-local))."
fi

# ---------------------------------------------------------------------------
# 8. GitHub CLI — used for the Copilot quick start
# ---------------------------------------------------------------------------
if [ "$SKIP_GH" = 1 ]; then
  step "GitHub CLI (skipped via --skip-gh)"
else
  step "GitHub CLI (gh)"

  if have gh; then
    ok "gh $(gh --version 2>/dev/null | head -n1)"
    if gh auth status >/dev/null 2>&1; then
      ok "gh is authenticated"
    else
      warn "gh is not authenticated — run: gh auth login"
    fi
  else
    bad "gh"
    if [ "$CHECK_ONLY" = 0 ] && [ "$PKG" = apt ] && confirm "Install GitHub CLI from the official apt repo?"; then
      $SUDO mkdir -p -m 755 /etc/apt/keyrings \
        && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
             | $SUDO tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
        && $SUDO chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
        && echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
             | $SUDO tee /etc/apt/sources.list.d/github-cli.list >/dev/null \
        && $SUDO apt-get update -y && $SUDO apt-get install -y gh \
        && ok "gh installed" || warn "install gh manually: https://cli.github.com/"
    else
      warn "install gh: https://cli.github.com/"
    fi
  fi
  info "Note: the token's account needs an ACTIVE GitHub Copilot entitlement;"
  info "'gh auth login' alone does not grant Copilot access."
fi

# ---------------------------------------------------------------------------
# 9. Optional tools (only needed for specific workstreams)
# ---------------------------------------------------------------------------
step "Optional (not needed for the Docker Compose workflow)"

have cargo   && ok "cargo $(cargo --version 2>/dev/null)" \
             || info "[opt]  Rust/Cargo — only to build apps/gateway outside Docker"
have kubectl && ok "kubectl present" || info "[opt]  kubectl — only for the pnpm k3d:* scripts"
have k3d     && ok "k3d present"     || info "[opt]  k3d — only for the pnpm k3d:* scripts"
have azd     && ok "azd present"     || info "[opt]  azd — only for Azure provisioning (infra/)"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
step "Summary"

if [ ${#MISSING[@]} -eq 0 ]; then
  ok "all required prerequisites are present"
else
  printf '    %sMissing / installed during this run:%s\n' "$C_BOLD" "$C_RESET"
  for m in "${MISSING[@]}"; do printf '      - %s\n' "$m"; done
fi

if [ ${#WARNINGS[@]} -gt 0 ]; then
  printf '\n    %sWarnings:%s\n' "$C_BOLD" "$C_RESET"
  for w in "${WARNINGS[@]}"; do printf '      - %s\n' "$w"; done
fi

cat <<'EOF'

Next steps
----------
  corepack enable
  pnpm install --frozen-lockfile

  gh auth login
  export GITHUB_TOKEN="$(gh auth token)"
  # Docker Engine on Linux only. Leave DOCKER_GID unset with Docker Desktop
  # (including WSL): its socket is GID 0 in containers, the Compose default.
  export DOCKER_GID="$(getent group docker | cut -d: -f3)"

  pnpm docker:dev:copilot     # full hot-reload stack (Copilot worker + Portal)
  pnpm open:portal            # opens http://localhost:5100 by default

Reminder: the ACP worker configuration mounts the Docker socket, so local
development is NOT a security sandbox. Do not expose this stack to the internet.
EOF

# Non-zero exit in --check mode when something is missing (useful in CI).
if [ "$CHECK_ONLY" = 1 ] && [ ${#MISSING[@]} -gt 0 ]; then exit 1; fi
exit 0
