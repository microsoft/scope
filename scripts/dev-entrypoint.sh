#!/bin/bash
set -e

# Dev entrypoint: runs shared package tsc --watch in the background,
# then starts the service with tsx watch for hot reload.
#
# Required env var:
#   SERVICE_DIR - relative path from /app/apps/ (e.g., "api", "judge", "workers/coder-acp-copilot")

if [ -z "$SERVICE_DIR" ]; then
  echo "ERROR: SERVICE_DIR env var is required"
  exit 1
fi

INSPECT_ARGS=()
if [ -n "${NODE_INSPECT_PORT:-}" ]; then
  if ! [[ "$NODE_INSPECT_PORT" =~ ^[0-9]+$ ]] || (( NODE_INSPECT_PORT < 1 || NODE_INSPECT_PORT > 65535 )); then
    echo "ERROR: NODE_INSPECT_PORT must be an integer between 1 and 65535"
    exit 1
  fi
  INSPECT_ARGS=("--inspect=0.0.0.0:${NODE_INSPECT_PORT}")
fi

# Sentinel file written by cancelExit() when a run is cancelled.
# When detected, we kill tsx watch and exit — stopping the container.
CANCEL_SENTINEL="/tmp/.scope-cancel-exit"
rm -f "$CANCEL_SENTINEL"

echo "[dev-entrypoint] Starting shared package watcher..."
cd /app/packages/shared && npx tsc --watch --preserveWatchOutput &
TSC_PID=$!

echo "[dev-entrypoint] Starting $SERVICE_DIR with tsx watch..."
cd /app/apps/$SERVICE_DIR
# Exclude shared dist — tsc --watch (above) already recompiles it and tsx
# re-resolves modules on import. Without this, every shared rebuild triggers
# a tsx restart that can overlap with in-flight message processing.
npx tsx watch --exclude '/app/packages/shared/dist/**' "${INSPECT_ARGS[@]}" src/index.ts &
TSX_PID=$!

# Forward SIGTERM/SIGINT to children so docker stop works gracefully
trap "kill $TSX_PID $TSC_PID 2>/dev/null; exit" SIGTERM SIGINT

# Monitor: wait for tsx watch to exit OR the cancel sentinel to appear.
# tsx watch normally never exits (it restarts its child on crash), so if we
# see the sentinel it means a cancel handler wrote it before process.exit(1)
# and tsx restarted the child — we kill everything and stop the container.
while true; do
  if [ -f "$CANCEL_SENTINEL" ]; then
    echo "[dev-entrypoint] Cancel sentinel detected, stopping container..."
    kill $TSX_PID $TSC_PID 2>/dev/null || true
    wait $TSX_PID 2>/dev/null || true
    exit 1
  fi
  if ! kill -0 $TSX_PID 2>/dev/null; then
    wait $TSX_PID 2>/dev/null
    EXIT_CODE=$?
    kill $TSC_PID 2>/dev/null || true
    exit $EXIT_CODE
  fi
  sleep 1
done
