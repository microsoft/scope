#!/usr/bin/env bash
# =============================================================================
# k3d-down.sh — Tear down the local k3d cluster
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Read port offset (env var takes precedence over file)
if [ -z "${PORT_OFFSET:-}" ]; then
  PORT_OFFSET=0
  if [ -f ".port-offset" ]; then
    PORT_OFFSET=$(cat .port-offset | tr -d '[:space:]')
  fi
fi

CLUSTER_NAME="scope-${PORT_OFFSET:-0}"

if ! k3d cluster list 2>/dev/null | grep -q "^$CLUSTER_NAME "; then
  echo "Cluster '$CLUSTER_NAME' does not exist."
  exit 0
fi

echo ">>> Deleting k3d cluster '$CLUSTER_NAME'..."
k3d cluster delete "$CLUSTER_NAME"

# NOTE: the image registry is intentionally NOT deleted here. It is a single
# registry shared by every worktree/cluster (caching image layers across them),
# so tearing it down with a per-worktree 'down' would wipe other worktrees'
# cached images. Remove it explicitly with 'pnpm k3d:registry:down' when you
# want to reclaim the space.
echo ">>> Cluster '$CLUSTER_NAME' deleted."
echo ""
echo "  The shared registry 'k3d-scope-registry.localhost:5050' is still running"
echo "  (shared by all worktrees). To remove it and wipe ALL cached images, run:"
echo "    pnpm k3d:registry:down"
