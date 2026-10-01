#!/usr/bin/env bash
# =============================================================================
# setup-linux-prereqs.sh — check/install Scope development prerequisites
# =============================================================================
# Detects the Linux distribution and installs (or verifies) everything needed
# to develop Scope with Docker Compose:
#   - Base tools: git, curl, openssl, tar, unzip, bash, ca-certificates
#   - libnss3-tools (mkcert dependency) and shasum (worktree-env.sh dependency)
#   - Node.js 22, corepack, and pnpm 10.29.1
#   - Docker Engine + Compose v2 (with `compose watch` support)
#   - mkcert (via GitHub releases)
#   - GitHub CLI (gh), used to obtain a Copilot token
#   - Optional: cargo, kubectl, k3d, azd
#
# Usage:
#   scripts/setup-linux-prereqs.sh [options]
#
# Options:
#   --check         Dry-run: only report what is missing, do not install
#                   anything. Exits with status 1 if anything is missing.
#   --skip-docker   Do not install/verify Docker Engine and Compose.
#   --skip-gh       Do not install/verify the GitHub CLI.
#   --yes, -y       Do not prompt for confirmation before installing.
#   -h, --help      Show this help text.
#
# See CONTRIBUTING.md for the full local development walkthrough.
# =============================================================================
set -euo pipefail

PNPM_VERSION="10.29.1"
NODE_MAJOR="22"
MKCERT_VERSION="v1.4.4"

CHECK_ONLY=false
SKIP_DOCKER=false
SKIP_GH=false
ASSUME_YES=false
MISSING=0

for arg in "$@"; do
  case "$arg" in
    --check)
      CHECK_ONLY=true
      ;;
    --skip-docker)
      SKIP_DOCKER=true
      ;;
    --skip-gh)
      SKIP_GH=true
      ;;
    --yes|-y)
      ASSUME_YES=true
      ;;
    -h|--help)
      awk 'NR==1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
      exit 0
      ;;
    *)
      echo "[setup-linux-prereqs] Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

log() {
  echo "[setup-linux-prereqs] $*"
}

warn() {
  echo "[setup-linux-prereqs] WARNING: $*" >&2
}

is_ci() {
  [[ -n "${CI:-}" || -n "${GITHUB_ACTIONS:-}" || -n "${TF_BUILD:-}" ]]
}

is_wsl() {
  [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qi microsoft /proc/version 2>/dev/null
}

confirm() {
  local prompt="$1"
  if $CHECK_ONLY; then
    # --check is a dry run: never prompt, never install.
    return 1
  fi
  if $ASSUME_YES || is_ci; then
    return 0
  fi
  read -r -p "$prompt [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

mark_missing() {
  MISSING=$((MISSING + 1))
  log "MISSING: $*"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# -----------------------------------------------------------------------------
# Distro / architecture detection
# -----------------------------------------------------------------------------
PKG_MANAGER=""
ARCH=""

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *)
      warn "Unrecognized architecture $(uname -m); some install steps may not work."
      ARCH="$(uname -m)"
      ;;
  esac
}

detect_package_manager() {
  if command_exists apt-get; then
    PKG_MANAGER="apt"
  elif command_exists dnf; then
    PKG_MANAGER="dnf"
  elif command_exists zypper; then
    PKG_MANAGER="zypper"
  elif command_exists pacman; then
    PKG_MANAGER="pacman"
  else
    warn "Could not detect a supported package manager (apt, dnf, zypper, pacman)."
    warn "Install prerequisites manually; see CONTRIBUTING.md."
    PKG_MANAGER="unknown"
  fi
}

# Tracks whether `apt-get update` has already run in this invocation so that
# repeated pkg_install calls (base tools, build deps, node, gh, ...) don't each
# re-run it. Set to true the first time pkg_install refreshes the apt cache.
APT_UPDATED=false

pkg_install() {
  # Installs one or more distro packages using the detected package manager.
  local pkgs=("$@")
  if [[ "$CHECK_ONLY" == true ]]; then
    return 0
  fi
  case "$PKG_MANAGER" in
    apt)
      if [[ "$APT_UPDATED" == false ]]; then
        sudo apt-get update -y
        APT_UPDATED=true
      fi
      sudo apt-get install -y "${pkgs[@]}"
      ;;
    dnf)
      sudo dnf install -y "${pkgs[@]}"
      ;;
    zypper)
      sudo zypper --non-interactive install "${pkgs[@]}"
      ;;
    pacman)
      sudo pacman -Sy --noconfirm "${pkgs[@]}"
      ;;
    *)
      warn "Cannot install ${pkgs[*]} automatically without a supported package manager."
      return 1
      ;;
  esac
}

# -----------------------------------------------------------------------------
# Base tools
# -----------------------------------------------------------------------------
check_or_install_base_tools() {
  log "Checking base tools (git, curl, openssl, tar, unzip, bash, ca-certificates)..."

  local tools=(git curl openssl tar unzip bash)
  local to_install=()

  for tool in "${tools[@]}"; do
    if command_exists "$tool"; then
      log "  ok: $tool"
    else
      mark_missing "$tool"
      to_install+=("$tool")
    fi
  done

  # ca-certificates has no CLI to probe for; check its installed state via the
  # package manager before deciding whether it needs to be (re)installed.
  local ca_certs_present=false
  case "$PKG_MANAGER" in
    apt) dpkg -s ca-certificates >/dev/null 2>&1 && ca_certs_present=true ;;
    dnf) rpm -q ca-certificates >/dev/null 2>&1 && ca_certs_present=true ;;
    zypper) rpm -q ca-certificates >/dev/null 2>&1 && ca_certs_present=true ;;
    pacman) pacman -Qi ca-certificates >/dev/null 2>&1 && ca_certs_present=true ;;
  esac

  if [[ "$ca_certs_present" == true ]]; then
    log "  ok: ca-certificates"
  else
    mark_missing "ca-certificates"
    to_install+=(ca-certificates)
  fi

  if [[ ${#to_install[@]} -gt 0 ]]; then
    if confirm "Install missing base tools (${to_install[*]})?"; then
      pkg_install "${to_install[@]}" || true
    fi
  fi
}

check_or_install_build_deps() {
  log "Checking build dependencies (libnss3-tools, shasum)..."

  if command_exists shasum || command_exists sha256sum; then
    log "  ok: shasum/sha256sum (used by scripts/worktree-env.sh)"
  else
    mark_missing "shasum (or sha256sum)"
    case "$PKG_MANAGER" in
      apt)
        if confirm "Install libdigest-sha-perl (provides shasum)?"; then
          pkg_install libdigest-sha-perl || true
        fi
        ;;
      dnf|zypper)
        if confirm "Install perl-Digest-SHA (provides shasum)?"; then
          pkg_install perl-Digest-SHA || true
        fi
        ;;
      pacman)
        if confirm "Install perl-digest-sha (provides shasum)?"; then
          pkg_install perl-digest-sha || true
        fi
        ;;
      *)
        warn "sha256sum is part of GNU coreutils and should already be present on most distros."
        warn "Install shasum manually (e.g. via your distro's Perl Digest::SHA package) if it is missing."
        ;;
    esac
  fi

  case "$PKG_MANAGER" in
    apt)
      if dpkg -s libnss3-tools >/dev/null 2>&1; then
        log "  ok: libnss3-tools (mkcert dependency)"
      else
        mark_missing "libnss3-tools"
        if confirm "Install libnss3-tools (mkcert dependency)?"; then
          pkg_install libnss3-tools || true
        fi
      fi
      ;;
    dnf)
      if rpm -q nss-tools >/dev/null 2>&1; then
        log "  ok: nss-tools (mkcert dependency)"
      else
        mark_missing "nss-tools"
        if confirm "Install nss-tools (mkcert dependency)?"; then
          pkg_install nss-tools || true
        fi
      fi
      ;;
    zypper)
      if rpm -q mozilla-nss-tools >/dev/null 2>&1; then
        log "  ok: mozilla-nss-tools (mkcert dependency)"
      else
        mark_missing "mozilla-nss-tools"
        if confirm "Install mozilla-nss-tools (mkcert dependency)?"; then
          pkg_install mozilla-nss-tools || true
        fi
      fi
      ;;
    pacman)
      if pacman -Qi nss >/dev/null 2>&1; then
        log "  ok: nss (mkcert dependency)"
      else
        mark_missing "nss"
        if confirm "Install nss (mkcert dependency)?"; then
          pkg_install nss || true
        fi
      fi
      ;;
  esac
}

# -----------------------------------------------------------------------------
# Node.js 22 + corepack + pnpm
# -----------------------------------------------------------------------------
check_or_install_node() {
  log "Checking Node.js ${NODE_MAJOR}..."

  # Scope pins CI and the `packageManager` field to Node 22.x specifically (see
  # CONTRIBUTING.md); a newer major version is intentionally still reported as
  # missing here so contributors match CI rather than an untested runtime.
  if command_exists node && [[ "$(node -v | sed 's/^v//' | cut -d. -f1)" == "$NODE_MAJOR" ]]; then
    log "  ok: node $(node -v)"
  else
    mark_missing "node.js ${NODE_MAJOR}.x"
    if confirm "Install Node.js ${NODE_MAJOR} from the official repository?"; then
      case "$PKG_MANAGER" in
        apt)
          curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
          pkg_install nodejs || true
          ;;
        dnf)
          curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
          pkg_install nodejs || true
          ;;
        *)
          warn "No official Node.js repository configured for this distro."
          warn "Install Node.js ${NODE_MAJOR} manually: https://nodejs.org/en/download"
          ;;
      esac
    fi
  fi

  log "Checking corepack + pnpm ${PNPM_VERSION}..."
  if command_exists corepack; then
    local current_pnpm_version=""
    if command_exists pnpm; then
      current_pnpm_version="$(pnpm --version 2>/dev/null || true)"
    fi

    if [[ "$current_pnpm_version" == "$PNPM_VERSION" ]]; then
      log "  ok: pnpm ${current_pnpm_version} already active via corepack"
    elif $CHECK_ONLY; then
      mark_missing "pnpm ${PNPM_VERSION} (found: ${current_pnpm_version:-none}; corepack can prepare it)"
    elif confirm "Activate pnpm ${PNPM_VERSION} via corepack (corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate)?"; then
      corepack enable >/dev/null 2>&1 || sudo corepack enable >/dev/null 2>&1 || true
      corepack prepare "pnpm@${PNPM_VERSION}" --activate
      local activated_pnpm_version=""
      if command_exists pnpm; then
        activated_pnpm_version="$(pnpm --version 2>/dev/null || true)"
      fi
      if [[ "$activated_pnpm_version" == "$PNPM_VERSION" ]]; then
        log "  ok: pnpm ${activated_pnpm_version} via corepack"
      else
        mark_missing "pnpm ${PNPM_VERSION} (activation reported version: ${activated_pnpm_version:-none})"
      fi
    else
      mark_missing "pnpm ${PNPM_VERSION} (found: ${current_pnpm_version:-none}; declined to activate via corepack)"
    fi
  else
    mark_missing "corepack (bundled with Node.js ${NODE_MAJOR})"
  fi
}

# -----------------------------------------------------------------------------
# Docker Engine + Compose v2
# -----------------------------------------------------------------------------
check_or_install_docker() {
  if $SKIP_DOCKER; then
    log "Skipping Docker checks (--skip-docker)."
    return 0
  fi

  log "Checking Docker Engine + Compose v2..."

  if command_exists docker; then
    log "  ok: docker $(docker --version 2>/dev/null || true)"
  else
    mark_missing "Docker Engine"
    if confirm "Install Docker Engine via get.docker.com convenience script?"; then
      curl -fsSL https://get.docker.com | sudo sh
      if command_exists usermod; then
        sudo usermod -aG docker "$USER"
        log "Added $USER to the 'docker' group."
        if is_wsl; then
          log "Run 'newgrp docker' (or restart your WSL shell) to pick up the new group before using docker."
        else
          log "Log out and back in (or run 'newgrp docker') to pick up the new group before using docker."
        fi
      fi
    fi
  fi

  if command_exists docker && docker compose version >/dev/null 2>&1; then
    log "  ok: docker compose $(docker compose version --short 2>/dev/null || true)"
    if docker compose watch --help >/dev/null 2>&1; then
      log "  ok: 'docker compose watch' is supported"
    else
      mark_missing "Docker Compose 'watch' support (needed by pnpm docker:dev:*; update Docker/Compose)"
    fi
  else
    mark_missing "Docker Compose v2 plugin"
  fi

  if command_exists docker; then
    local docker_gid
    docker_gid="$(getent group docker 2>/dev/null | cut -d: -f3 || true)"
    if [[ -n "$docker_gid" ]]; then
      log "DOCKER_GID=${docker_gid} (export this in your .env for ACP worker container socket access)"
    fi
  fi
}

# -----------------------------------------------------------------------------
# mkcert
# -----------------------------------------------------------------------------
check_or_install_mkcert() {
  log "Checking mkcert..."

  if command_exists mkcert; then
    log "  ok: mkcert $(mkcert -version 2>&1 || true)"
    return 0
  fi

  mark_missing "mkcert"
  if confirm "Install mkcert ${MKCERT_VERSION} from GitHub releases?"; then
    local url="https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VERSION}/mkcert-${MKCERT_VERSION}-linux-${ARCH}"
    local tmp
    tmp="$(mktemp)"
    curl -fsSL -o "$tmp" "$url"
    chmod +x "$tmp"
    sudo mv "$tmp" /usr/local/bin/mkcert
    log "  installed: mkcert $(mkcert -version 2>&1 || true)"
  fi

  if is_wsl; then
    log "WSL note: mkcert installs its CA into the Linux trust store, but your browser"
    log "  usually runs on Windows. Either run your browser inside WSLg, or copy the CA"
    log "  from 'mkcert -CAROOT' into Windows' trusted root certificate store."
  fi
}

# -----------------------------------------------------------------------------
# GitHub CLI
# -----------------------------------------------------------------------------
check_or_install_gh() {
  if $SKIP_GH; then
    log "Skipping GitHub CLI checks (--skip-gh)."
    return 0
  fi

  log "Checking GitHub CLI (gh)..."

  if command_exists gh; then
    log "  ok: gh $(gh --version | head -n1)"
    return 0
  fi

  mark_missing "GitHub CLI (gh)"
  if confirm "Install GitHub CLI (gh)?"; then
    case "$PKG_MANAGER" in
      apt)
        sudo mkdir -p -m 755 /etc/apt/keyrings
        curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
        sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
        pkg_install gh || true
        ;;
      dnf)
        sudo dnf install -y 'dnf-command(config-manager)'
        sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
        pkg_install gh || true
        ;;
      zypper)
        pkg_install gh || true
        ;;
      pacman)
        pkg_install github-cli || true
        ;;
      *)
        warn "Install gh manually: https://github.com/cli/cli#installation"
        ;;
    esac
  fi
}

# -----------------------------------------------------------------------------
# Optional tools
# -----------------------------------------------------------------------------
check_optional_tools() {
  log "Checking optional tools (cargo, kubectl, k3d, azd)..."

  if command_exists cargo; then
    log "  ok: cargo (optional; only needed for apps/gateway)"
  else
    log "  optional, not found: cargo — install via https://rustup.rs if you work on apps/gateway"
  fi

  if command_exists kubectl; then
    log "  ok: kubectl (optional; only needed for k3d workflows)"
  else
    log "  optional, not found: kubectl — install via https://kubernetes.io/docs/tasks/tools/ if you use pnpm k3d:*"
  fi

  if command_exists k3d; then
    log "  ok: k3d (optional; only needed for k3d workflows)"
  else
    log "  optional, not found: k3d — install via https://k3d.io/#installation if you use pnpm k3d:*"
  fi

  if command_exists azd; then
    log "  ok: azd (optional; only needed for Azure provisioning)"
  else
    log "  optional, not found: azd — install via https://aka.ms/azd-install if you provision Azure infra"
  fi
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
  detect_arch
  detect_package_manager

  log "Detected package manager: ${PKG_MANAGER}, architecture: ${ARCH}"
  if is_wsl; then
    log "Detected WSL environment (${WSL_DISTRO_NAME:-unknown distro})."
  fi
  if $CHECK_ONLY; then
    log "Running in --check mode: no changes will be made."
  fi

  check_or_install_base_tools
  check_or_install_build_deps
  check_or_install_node
  check_or_install_docker
  check_or_install_mkcert
  check_or_install_gh
  check_optional_tools

  echo ""
  if [[ $MISSING -eq 0 ]]; then
    log "All required prerequisites are present."
  else
    log "${MISSING} required prerequisite(s) missing."
  fi

  if is_wsl && command_exists docker; then
    log "WSL tip: if 'docker' commands fail with a permission error after group changes, run 'newgrp docker' or restart your WSL shell."
  fi

  log "Next: see CONTRIBUTING.md for 'pnpm install' and 'pnpm docker:dev:copilot'."

  if $CHECK_ONLY && [[ $MISSING -gt 0 ]]; then
    exit 1
  fi
}

main "$@"
