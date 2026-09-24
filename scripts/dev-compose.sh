#!/usr/bin/env bash
# =============================================================================
# dev-compose.sh — Docker Compose wrapper with shared-infra auto-detection
# =============================================================================
# Replaces direct `docker compose` calls in pnpm scripts. Automatically:
#   - Loads generated .env, then( overlays .env.local if it exists)
#   - Adds --profile mongodb (starts local MongoDB) UNLESS SCOPE_SHARED_INFRA=1
#   - Strips 'mongodb' from service arguments when using shared infra
#
# Usage (in package.json scripts):
#   "docker:up": "worktree-env && scripts/dev-compose.sh up --build"
# =============================================================================
set -euo pipefail

# Ensure common tool paths are available (Docker Desktop, Homebrew, etc.)
# Scripts may run in environments that only inherit the system PATH.
for p in /usr/local/bin /opt/homebrew/bin "$HOME/.docker/bin"; do
  [[ -d "$p" ]] && [[ ":$PATH:" != *":$p:"* ]] && export PATH="$p:$PATH"
done

# ---------------------------------------------------------------------------
# Forward the host's npm registry into the image builds.
# ---------------------------------------------------------------------------
# docker-compose.yml passes ${NPM_CONFIG_REGISTRY} to every image build as a
# build arg (default: the public registry). Detect the registry configured on
# the host (npm/pnpm read ~/.npmrc) and forward it, so engineers whose network
# cannot reach registry.npmjs.org directly — e.g. behind Microsoft's npm proxy —
# build out of the box. External contributors detect the public registry and are
# unaffected. An explicitly exported NPM_CONFIG_REGISTRY always wins.
if [ -z "${NPM_CONFIG_REGISTRY:-}" ]; then
  detected_registry="$(npm config get registry 2>/dev/null || pnpm config get registry 2>/dev/null || true)"
  case "$detected_registry" in
    http://*|https://*) export NPM_CONFIG_REGISTRY="$detected_registry" ;;
  esac
fi

# Read SCOPE_SHARED_INFRA flag safely (no source to avoid special char issues)
if [ -f .env.local ]; then
  SCOPE_SHARED_INFRA=$(grep "^SCOPE_SHARED_INFRA=" .env.local | cut -d= -f2- || true)
fi

EXTRA_ARGS=()

# When the `auth` profile is active, ensure the entra-local HTTPS cert exists and
# the local CA is trusted (MSAL requires an https authority). Idempotent.
for arg in "$@"; do
  if [ "$arg" = "auth" ]; then
    "$(dirname "$0")/ensure-dev-certs.sh"
    break
  fi
done

# Passing any --env-file disables Compose's implicit .env loading. Include the
# generated worktree file explicitly before .env.local so local overrides do not
# discard COMPOSE_PROJECT_NAME or the worktree's offset ports.
if [ -f .env.local ]; then
  EXTRA_ARGS+=(--env-file .env --env-file .env.local)
fi

# Handle mongodb: add profile OR strip from service args
if [ "${SCOPE_SHARED_INFRA:-}" != "1" ]; then
  EXTRA_ARGS+=(--profile mongodb)
else
  # Strip 'mongodb' from positional args (service names) when using shared infra
  FILTERED_ARGS=()
  for arg in "$@"; do
    if [ "$arg" != "mongodb" ]; then
      FILTERED_ARGS+=("$arg")
    fi
  done
  set -- "${FILTERED_ARGS[@]}"
fi

exec docker compose "${EXTRA_ARGS[@]}" "$@"
