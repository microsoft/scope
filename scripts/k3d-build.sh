#!/usr/bin/env bash
# =============================================================================
# k3d-build.sh — Build and push Docker images to local k3d registry
# =============================================================================
# Usage:
#   ./scripts/k3d-build.sh                    # Build core + copilot worker (default)
#   ./scripts/k3d-build.sh --worker=claude    # Build core + claude worker
#   ./scripts/k3d-build.sh --worker=all       # Build core + all workers
#   ./scripts/k3d-build.sh --worker=none      # Build core services only (no workers)
#   ./scripts/k3d-build.sh api                # Build only the api
#   ./scripts/k3d-build.sh api portal         # Build api and portal
#   ./scripts/k3d-build.sh --no-cache         # Full rebuild without cache
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Ensure Docker Desktop CLI tools are on PATH (OrbStack symlinks may be broken)
[ -d "/Applications/Docker.app/Contents/Resources/bin" ] \
  && export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"

# ── Detect container runtime ────────────────────────────────────────────────
# Podman lacks `docker buildx` and its docker-compat push endpoint is unreliable,
# so podman builds/pushes with the native `podman` CLI instead. Override with
# CONTAINER_RUNTIME=podman|docker. (Capture `docker version` via command
# substitution — piping into `grep -q` trips SIGPIPE under `set -o pipefail`.)
if [ -z "${CONTAINER_RUNTIME:-}" ]; then
  if command -v docker &>/dev/null; then
    case "$(docker version 2>/dev/null || true)" in
      *[Pp]odman*) CONTAINER_RUNTIME="podman" ;;
      *)           CONTAINER_RUNTIME="docker" ;;
    esac
  elif command -v podman &>/dev/null; then
    CONTAINER_RUNTIME="podman"
  else
    CONTAINER_RUNTIME="docker"
  fi
fi

# Read port offset (env var takes precedence over file). The offset identifies the
# worktree; it is used to derive the per-worktree image TAG below. The registry
# itself is shared across all worktrees (fixed name + port), not per-offset.
if [ -z "${PORT_OFFSET:-}" ]; then
  PORT_OFFSET=0
  if [ -f ".port-offset" ]; then
    PORT_OFFSET=$(cat .port-offset | tr -d '[:space:]')
  fi
fi

# ── Shared registry + per-worktree image tag ──────────────────────────────
# A single registry (fixed name/port) is shared by every worktree/cluster so
# image layers are cached and de-duplicated across worktrees. Isolation comes
# from a per-worktree image TAG (the worktree directory name) — no worktree can
# overwrite another's images. Override with IMAGE_TAG=... if needed.
REGISTRY_PORT=5050
REGISTRY="scope-registry.localhost:${REGISTRY_PORT}"
WORKTREE_NAME=$(basename "$REPO_ROOT")
# Tag combines offset (unique among live worktrees) + worktree dir name, e.g.
# 'sc-64-jduffney-microsoft-add-k3d-local-dev'. Must match k3d-up.sh.
IMAGE_TAG="${IMAGE_TAG:-sc-${PORT_OFFSET}-${WORKTREE_NAME}}"

# Ensure pushes to the local registry bypass any Docker/corporate proxy
export NO_PROXY="${NO_PROXY:+${NO_PROXY},}scope-registry.localhost,localhost,127.0.0.1"
export no_proxy="$NO_PROXY"

# Parse flags
NO_CACHE=""
WORKER="copilot"
BUILD_TARGETS=""
for arg in "$@"; do
  case "$arg" in
    --no-cache) NO_CACHE="--no-cache" ;;
    --worker=*) WORKER="${arg#--worker=}" ;;
    *) BUILD_TARGETS="${BUILD_TARGETS:+$BUILD_TARGETS }$arg" ;;
  esac
done

# Core services (always built unless specific targets given)
CORE_SERVICES="api judge portal token-manager scheduler gateway"

# Resolve worker list based on --worker flag
case "$WORKER" in
  copilot) WORKER_SERVICES="coder-acp-copilot" ;;
  claude)  WORKER_SERVICES="coder-acp-claude-code" ;;
  all)     WORKER_SERVICES="coder-acp-copilot coder-acp-claude-code" ;;
  none)    WORKER_SERVICES="" ;;
  *) echo "Error: Unknown worker '$WORKER'. Use: copilot, claude, all, none"; exit 1 ;;
esac

# All known services (must match targets in docker-bake.hcl)
ALL_SERVICES="$CORE_SERVICES $WORKER_SERVICES"

# Validate requested targets (check against all possible services)
VALID_SERVICES="api judge portal token-manager scheduler gateway coder-acp-copilot coder-acp-claude-code"
for svc in $BUILD_TARGETS; do
  valid=false
  for known in $VALID_SERVICES; do
    if [ "$svc" = "$known" ]; then valid=true; break; fi
  done
  if [ "$valid" = "false" ]; then
    echo "Error: Unknown service '$svc'"
    echo "Available services: $VALID_SERVICES"
    exit 1
  fi
done

echo ">>> Building images → $REGISTRY (tag: $IMAGE_TAG)"

# ── Source worker version files as env vars for docker-bake.hcl ───────────
for versions_file in apps/workers/*/versions.env apps/*/versions.env; do
  if [ -f "$versions_file" ]; then
    set -a
    source "$versions_file"
    set +a
  fi
done

# ── Podman: build + push with the native podman CLI ───────────────────────
# Podman has no `docker buildx bake`, and pushing to the k3d HTTP registry via
# the docker-compat socket returns HTTP 500. Instead build each image with
# `podman build` and push to the registry over localhost (which podman treats
# as insecure by default). Images land in repo path `scoped/<svc>`, which the
# in-cluster `k3d-<registry>:5000` mirror resolves for pod pulls.
if [ "$CONTAINER_RUNTIME" = "podman" ]; then
  if [ -z "$BUILD_TARGETS" ]; then
    PODMAN_BUILD_LIST="$ALL_SERVICES"
  else
    PODMAN_BUILD_LIST="$BUILD_TARGETS"
  fi

  echo "    Runtime: podman — sequential build + push → localhost:${REGISTRY_PORT} (tag: ${IMAGE_TAG})"
  echo ""

  podman_build_push() {
    local svc=$1
    local dockerfile context image
    local target_args=() build_args=()

    case "$svc" in
      gateway)     dockerfile="apps/gateway/Dockerfile"; context="apps/gateway"; target_args=(--target runtime) ;;
      coder-acp-*) dockerfile="apps/workers/${svc}/Dockerfile"; context="." ;;
      *)           dockerfile="apps/${svc}/Dockerfile"; context="." ;;
    esac

    if [ ! -f "$dockerfile" ]; then
      echo "  ⚠ $svc: $dockerfile not found — skipping"
      return 0
    fi

    case "$svc" in
      coder-acp-copilot)
        build_args=(--build-arg "COPILOT_CLI_VERSION=${COPILOT_CLI_VERSION:-}") ;;
      coder-acp-claude-code)
        build_args=(--build-arg "CLAUDE_CODE_ACP_VERSION=${CLAUDE_CODE_ACP_VERSION:-}"
                    --build-arg "CLAUDE_AGENT_SDK_VERSION=${CLAUDE_AGENT_SDK_VERSION:-}") ;;
    esac

    # Push over localhost (insecure) but keep the repo path pods expect. The tag
    # is per-worktree so images stay isolated in the shared registry.
    image="localhost:${REGISTRY_PORT}/scoped/${svc}:${IMAGE_TAG}"

    echo "  Building $svc..."
    if ! podman build ${NO_CACHE} "${target_args[@]}" "${build_args[@]}" \
        -t "$image" -f "$dockerfile" "$context"; then
      echo "  ✗ $svc build FAILED"
      return 1
    fi
    if ! podman push --tls-verify=false "$image"; then
      echo "  ✗ $svc push FAILED"
      return 1
    fi
    echo "  ✓ $svc (pushed)"
  }

  BUILD_FAILED=0
  for svc in $PODMAN_BUILD_LIST; do
    podman_build_push "$svc" || BUILD_FAILED=1
  done

  [ "$BUILD_FAILED" -eq 0 ] || { echo ""; echo "  ⚠ One or more images failed to build/push."; exit 1; }
  exit 0
fi

# ── Try parallel build with docker buildx bake ────────────────────────────
# Uses the default "docker" driver so builds share the host network and can
# push to the local k3d HTTP registry without insecure-registry workarounds.
if docker buildx bake --help &>/dev/null; then
  # Use default builder (docker driver) — it shares host network so it can
  # resolve the k3d registry on localhost. The docker-container driver runs
  # in its own container and cannot reach localhost registries.
  docker buildx use default 2>/dev/null || true

  BAKE_ARGS=(--file docker-bake.hcl --load)

  if [ -n "$NO_CACHE" ]; then
    BAKE_ARGS+=(--no-cache)
  fi

  if [ -z "$BUILD_TARGETS" ]; then
    echo "    Services: ALL (parallel)"
    REGISTRY="$REGISTRY" TAG="$IMAGE_TAG" docker buildx bake "${BAKE_ARGS[@]}"
    PUSH_LIST="$ALL_SERVICES"
  else
    echo "    Services: $BUILD_TARGETS (parallel)"
    REGISTRY="$REGISTRY" TAG="$IMAGE_TAG" docker buildx bake "${BAKE_ARGS[@]}" $BUILD_TARGETS
    PUSH_LIST="$BUILD_TARGETS"
  fi

  # Push images to local registry with timeout; fall back to k3d image import
  CLUSTER_NAME="scope-${PORT_OFFSET:-0}"
  echo ""
  echo ">>> Loading images into cluster '$CLUSTER_NAME'..."
  for svc in $PUSH_LIST; do
    image="${REGISTRY}/scoped/${svc}:${IMAGE_TAG}"
    # Try push with 30s timeout first (fast when Docker Desktop cooperates)
    if timeout 60 docker push "$image" --quiet 2>/dev/null; then
      echo "  ✓ $svc (pushed)"
    else
      # Fall back to k3d image import (reliable, no registry needed)
      k3d image import "$image" --cluster "$CLUSTER_NAME" 2>/dev/null \
        && echo "  ✓ $svc (imported)" \
        || echo "  ⚠ $svc FAILED"
    fi
  done

  exit 0
fi

# ── Fallback: sequential docker build + push ──────────────────────────────
echo "  ⚠ docker buildx bake unavailable — falling back to sequential builds"
echo "    Install BuildKit for faster parallel builds."
echo ""

get_dockerfile() {
  local name=$1
  case "$name" in
    gateway) echo "apps/gateway/Dockerfile" ;;
    coder-acp-*) echo "apps/workers/${name}/Dockerfile" ;;
    *) echo "apps/${name}/Dockerfile" ;;
  esac
}

get_build_context() {
  local name=$1
  case "$name" in
    gateway) echo "apps/gateway" ;;
    *) echo "." ;;
  esac
}

get_target() {
  local name=$1
  case "$name" in
    gateway) echo "runtime" ;;
    *) echo "" ;;
  esac
}

build_and_push() {
  local name=$1
  local dockerfile=$(get_dockerfile "$name")
  local context=$(get_build_context "$name")
  local target=$(get_target "$name")
  local image="${REGISTRY}/scoped/${name}:${IMAGE_TAG}"

  if [ ! -f "$dockerfile" ]; then
    echo "  Warning: Dockerfile not found at $dockerfile, skipping $name"
    return 0
  fi

  local target_arg=""
  if [ -n "$target" ]; then target_arg="--target $target"; fi

  echo "  Building $name..."
  if ! docker build --file "$dockerfile" --tag "$image" ${target_arg} ${NO_CACHE} --quiet "$context"; then
    echo "  ⚠ Build failed for $name — skipping"
    return 0
  fi
}

if [ -z "$BUILD_TARGETS" ]; then
  BUILD_LIST="$ALL_SERVICES"
else
  BUILD_LIST="$BUILD_TARGETS"
fi

echo "    Services: $BUILD_LIST (sequential)"
echo ""

for svc in $BUILD_LIST; do
  build_and_push "$svc"
done

# Push all built images to registry
echo ""
echo ">>> Pushing images to $REGISTRY..."
for svc in $BUILD_LIST; do
  echo "  Pushing $svc..."
  docker push "${REGISTRY}/scoped/${svc}:${IMAGE_TAG}" --quiet
done
echo "  ✓ All images pushed"
