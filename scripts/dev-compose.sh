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
# Forward package and package-manager bootstrap registries into image builds.
# ---------------------------------------------------------------------------
# docker-compose.yml passes ${NPM_CONFIG_REGISTRY} to every image build as a
# build arg (default: the public registry). Detect the registry configured on
# the host (npm/pnpm read ~/.npmrc) and forward it, so engineers whose network
# cannot reach registry.npmjs.org directly — e.g. behind Microsoft's npm proxy —
# build out of the box. External contributors detect the public registry and are
# unaffected. An explicitly exported NPM_CONFIG_REGISTRY always wins.
#
# COREPACK_NPM_REGISTRY is intentionally not inferred from the package registry:
# only forward it when the user explicitly selected a Corepack-compatible
# metadata endpoint.
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

COMPOSE_ARGS=("${EXTRA_ARGS[@]}" "$@")

# Only `up` starts services that can be verified. Preserve direct exec behavior
# for config, build, down, and every other Compose command.
up_index=-1
for index in "${!COMPOSE_ARGS[@]}"; do
  if [ "${COMPOSE_ARGS[$index]}" = "up" ]; then
    up_index="$index"
    break
  fi
done

if [ "$up_index" -lt 0 ]; then
  exec docker compose "${COMPOSE_ARGS[@]}"
fi

COMPOSE_PREFIX=("${COMPOSE_ARGS[@]:0:$up_index}")
UP_ARGS=("${COMPOSE_ARGS[@]:$((up_index + 1))}")
EXPLICIT_SERVICES=()
skip_next=0
for arg in "${UP_ARGS[@]}"; do
  if [ "$skip_next" -eq 1 ]; then
    skip_next=0
    continue
  fi
  case "$arg" in
    --scale|--timeout|--wait-timeout|--pull)
      skip_next=1
      ;;
    -*)
      ;;
    *)
      EXPLICIT_SERVICES+=("$arg")
      ;;
  esac
done

VERIFY_SERVICES=""
if [ "${#EXPLICIT_SERVICES[@]}" -gt 0 ]; then
  for service in "${EXPLICIT_SERVICES[@]}"; do
    case "$service" in
      portal|api|gateway|coder-acp-copilot)
        VERIFY_SERVICES+="${VERIFY_SERVICES:+$'\n'}$service"
        ;;
    esac
  done
fi

# Explicit infra-only starts intentionally skip application readiness checks.
if [ "${#EXPLICIT_SERVICES[@]}" -gt 0 ] && [ -z "$VERIFY_SERVICES" ]; then
  exec docker compose "${COMPOSE_ARGS[@]}"
fi

# Resolve profile-selected application services before startup. This lets the
# wrapper distinguish a legitimate image build (containers do not exist yet)
# from the bounded readiness phase after Compose begins creating containers.
if [ -z "$VERIFY_SERVICES" ]; then
  selected_services="$(docker compose "${COMPOSE_PREFIX[@]}" config --services)"
  for service in portal api gateway coder-acp-copilot; do
    if grep -qx "$service" <<<"$selected_services"; then
      VERIFY_SERVICES+="${VERIFY_SERVICES:+$'\n'}$service"
    fi
  done
fi

compose_pid=""
verify_pid=""
cleanup_children() {
  local signal="$1"
  if [ -n "$verify_pid" ] && kill -0 "$verify_pid" 2>/dev/null; then
    kill "-$signal" "$verify_pid" 2>/dev/null || true
  fi
  if [ -n "$compose_pid" ] && kill -0 "$compose_pid" 2>/dev/null; then
    kill "-$signal" "$compose_pid" 2>/dev/null || true
  fi
}
trap 'cleanup_children INT; exit 130' INT
trap 'cleanup_children TERM; exit 143' TERM

docker compose "${COMPOSE_ARGS[@]}" &
compose_pid=$!

# Do not consume the endpoint readiness budget while Compose is still building
# images and none of the expected application containers can exist. This gate
# is tied to the Compose lifecycle rather than an arbitrary clean-build timer:
# it ends when every selected container has been created or Compose exits.
while [ -n "$compose_pid" ]; do
  all_containers_created=1
  while IFS= read -r service; do
    [ -n "$service" ] || continue
    if [ -z "$(docker compose "${COMPOSE_PREFIX[@]}" ps -q "$service" 2>/dev/null | head -n 1)" ]; then
      all_containers_created=0
      break
    fi
  done <<<"$VERIFY_SERVICES"

  if [ "$all_containers_created" -eq 1 ]; then
    break
  fi

  if ! kill -0 "$compose_pid" 2>/dev/null; then
    set +e
    wait "$compose_pid"
    compose_status=$?
    set -e
    compose_pid=""
    if [ "$compose_status" -ne 0 ]; then
      exit "$compose_status"
    fi
    break
  fi

  sleep 0.2
done

SCOPE_DEV_VERIFY_SERVICES="$VERIFY_SERVICES" \
  "$(dirname "$0")/verify-dev-stack.sh" "${COMPOSE_PREFIX[@]}" &
verify_pid=$!

# Fail fast if Compose itself exits unsuccessfully during build/startup. A
# successful detached `up -d` is allowed to exit while verification continues.
compose_status=""
while kill -0 "$verify_pid" 2>/dev/null; do
  if [ -n "$compose_pid" ] && ! kill -0 "$compose_pid" 2>/dev/null; then
    set +e
    wait "$compose_pid"
    compose_status=$?
    set -e
    compose_pid=""
    if [ "$compose_status" -ne 0 ]; then
      kill "$verify_pid" 2>/dev/null || true
      wait "$verify_pid" 2>/dev/null || true
      exit "$compose_status"
    fi
  fi
  sleep 0.2
done

set +e
wait "$verify_pid"
verify_status=$?
set -e
verify_pid=""

if [ "$verify_status" -ne 0 ]; then
  if [ -n "$compose_pid" ] && kill -0 "$compose_pid" 2>/dev/null; then
    kill -TERM "$compose_pid" 2>/dev/null || true
    wait "$compose_pid" 2>/dev/null || true
  fi
  exit "$verify_status"
fi

if [ -n "$compose_pid" ]; then
  set +e
  wait "$compose_pid"
  compose_status=$?
  set -e
fi

exit "${compose_status:-0}"
