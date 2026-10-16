#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
#
# One-shot setup for the two ACP coding-agent workers (coder-acp-copilot,
# coder-acp-claude-code) on top of an already-`helm install`ed Scope
# release (see deploy/helm/scope/README.md "Phase 1/2"). This is the
# single entry point for "Phase 3": it builds + pushes both worker images
# to your ACR, flips them on via `helm upgrade`, and registers each agent
# with the API. You should not need to run any `az acr build`/`helm
# upgrade --set workers...`/`register-agent.sh` commands by hand — this
# script wraps all of them.
#
# This script does NOT register worker credentials (GitHub token,
# Anthropic API key). Add those yourself via the Portal's "Create Token"
# page (or POST /api/v1/keys directly) after the workers are up — see
# deploy/helm/scope/WORKERS.md.
#
# Usage:
#   scripts/bootstrap-workers.sh --acr <acrLoginServerOrName> [options]
#
# Options:
#   --acr <name>            ACR name or login server (required; e.g. myacr
#                            or myacr.azurecr.io)
#   --namespace <ns>         Kubernetes namespace (default: scope)
#   --release <name>         Helm release name (default: scope)
#   --chart <path>           Helm chart path (default: deploy/helm/scope,
#                            relative to repo root)
#   --image-tag <tag>        Tag to build/push/deploy (default: a unique tag
#                            derived from the current git commit, e.g.
#                            a1b2c3d or a1b2c3d-dirty). Rerunning this script
#                            with the mutable "latest" tag would push new
#                            image content without changing the rendered
#                            Deployment PodTemplate, so Helm would leave the
#                            old pods running — see deploy/helm/scope/
#                            README.md "Phase 3" for details.
#   --values-file <path>     Same values override file passed to the
#                            original `helm install ... -f <path>` (see
#                            README.md "Install (Phase 2)"). Strongly
#                            recommended: without it, this script falls back
#                            to `helm upgrade --reuse-values`, which freezes
#                            the release's previously computed values and
#                            will NOT pick up new default keys added to the
#                            chart's values.yaml since the initial install
#                            (this silently broke worker agentVersion/
#                            queueName in testing — see README "Phase 3").
#   --skip-copilot           Skip the coder-acp-copilot worker entirely
#   --skip-claude-code       Skip the coder-acp-claude-code worker entirely
#   --skip-build             Reuse already-pushed images; skip `az acr build`
#   --skip-agent-registration
#                            Skip the scripts/register-agent.sh step
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

NAMESPACE="scope"
RELEASE_NAME="scope"
CHART_PATH="deploy/helm/scope"
# Default to a unique tag derived from the current commit so each run
# produces a distinct tag and the rendered Deployment PodTemplate actually
# changes (a mutable tag like "latest" lets Helm think nothing changed and
# leave old pods running — see --image-tag help above). Falls back to a
# timestamp if this isn't a git checkout.
if git -C "$REPO_ROOT" rev-parse --short HEAD >/dev/null 2>&1; then
  IMAGE_TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  if ! git -C "$REPO_ROOT" diff --quiet HEAD -- 2>/dev/null; then
    IMAGE_TAG="${IMAGE_TAG}-dirty"
  fi
else
  IMAGE_TAG="$(date +%Y%m%d%H%M%S)"
fi
VALUES_FILE=""
ACR_NAME=""
SKIP_COPILOT=false
SKIP_CLAUDE_CODE=false
SKIP_BUILD=false
SKIP_AGENT_REGISTRATION=false

log() { printf '\n==> %s\n' "$1"; }
die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

usage() {
  sed -n '2,51p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --acr)
      ACR_NAME="$2"
      shift 2
      ;;
    --namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    --release)
      RELEASE_NAME="$2"
      shift 2
      ;;
    --chart)
      CHART_PATH="$2"
      shift 2
      ;;
    --image-tag)
      IMAGE_TAG="$2"
      shift 2
      ;;
    --values-file)
      VALUES_FILE="$2"
      shift 2
      ;;
    --skip-copilot)
      SKIP_COPILOT=true
      shift
      ;;
    --skip-claude-code)
      SKIP_CLAUDE_CODE=true
      shift
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --skip-agent-registration)
      SKIP_AGENT_REGISTRATION=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1 (see --help)"
      ;;
  esac
done

[ -n "$ACR_NAME" ] || die "--acr is required (ACR name or login server)"
ACR_LOGIN_SERVER="$ACR_NAME"
case "$ACR_LOGIN_SERVER" in
  *.azurecr.io) ;;
  *) ACR_LOGIN_SERVER="${ACR_NAME}.azurecr.io" ;;
esac
ACR_SHORT_NAME="${ACR_LOGIN_SERVER%%.*}"

if [ -n "$VALUES_FILE" ] && [ ! -f "$VALUES_FILE" ]; then
  die "--values-file not found: $VALUES_FILE"
fi

for bin in az helm kubectl curl; do
  command -v "$bin" >/dev/null 2>&1 || die "$bin is required on PATH"
done
if [ "$SKIP_AGENT_REGISTRATION" = false ] && ! command -v yq >/dev/null 2>&1; then
  die "yq is required for agent registration (brew install yq), or pass --skip-agent-registration"
fi

cd "$REPO_ROOT"

# -----------------------------------------------------------------------------
# 1. Build + push worker images to ACR (az acr build — no local Docker
#    needed).
# -----------------------------------------------------------------------------
if [ "$SKIP_BUILD" = false ]; then
  if [ "$SKIP_COPILOT" = false ]; then
    log "Building coder-acp-copilot:$IMAGE_TAG on $ACR_SHORT_NAME"
    COPILOT_CLI_VERSION=$(grep '^COPILOT_CLI_VERSION=' apps/workers/coder-acp-copilot/versions.env | cut -d= -f2)
    az acr build --registry "$ACR_SHORT_NAME" --image "scope-coder-acp-copilot:$IMAGE_TAG" \
      -f apps/workers/coder-acp-copilot/Dockerfile \
      --build-arg "COPILOT_CLI_VERSION=$COPILOT_CLI_VERSION" .
  fi
  if [ "$SKIP_CLAUDE_CODE" = false ]; then
    log "Building coder-acp-claude-code:$IMAGE_TAG on $ACR_SHORT_NAME"
    CLAUDE_CODE_ACP_VERSION=$(grep '^CLAUDE_CODE_ACP_VERSION=' apps/workers/coder-acp-claude-code/versions.env | cut -d= -f2)
    CLAUDE_AGENT_SDK_VERSION=$(grep '^CLAUDE_AGENT_SDK_VERSION=' apps/workers/coder-acp-claude-code/versions.env | cut -d= -f2)
    az acr build --registry "$ACR_SHORT_NAME" --image "scope-coder-acp-claude-code:$IMAGE_TAG" \
      -f apps/workers/coder-acp-claude-code/Dockerfile \
      --build-arg "CLAUDE_CODE_ACP_VERSION=$CLAUDE_CODE_ACP_VERSION" \
      --build-arg "CLAUDE_AGENT_SDK_VERSION=$CLAUDE_AGENT_SDK_VERSION" .
  fi
else
  log "Skipping image build (--skip-build); assuming $ACR_LOGIN_SERVER already has the images tagged $IMAGE_TAG"
fi

# -----------------------------------------------------------------------------
# 2. Temporary port-forward to the API, used for agent registration
#    below.
# -----------------------------------------------------------------------------
API_LOCAL_PORT=18080
API_URL="http://127.0.0.1:$API_LOCAL_PORT"
PORT_FORWARD_PID=""

start_port_forward() {
  [ -n "$PORT_FORWARD_PID" ] && return 0
  log "Port-forwarding svc/api -n $NAMESPACE -> localhost:$API_LOCAL_PORT"
  kubectl -n "$NAMESPACE" port-forward svc/api "$API_LOCAL_PORT:80" >/tmp/scope-bootstrap-workers-pf.log 2>&1 &
  PORT_FORWARD_PID=$!
  for _ in $(seq 1 30); do
    if curl -sf -o /dev/null "$API_URL/health"; then
      return 0
    fi
    sleep 1
  done
  die "api did not become reachable through the port-forward (see /tmp/scope-bootstrap-workers-pf.log)"
}

stop_port_forward() {
  if [ -n "$PORT_FORWARD_PID" ]; then
    kill "$PORT_FORWARD_PID" >/dev/null 2>&1 || true
    wait "$PORT_FORWARD_PID" 2>/dev/null || true
    PORT_FORWARD_PID=""
  fi
}
trap stop_port_forward EXIT

# -----------------------------------------------------------------------------
# 3. Enable the worker Deployments via `helm upgrade` (chart already has
#    them templated, gated on workers.<name>.enabled — see
#    deploy/helm/scope/templates/workers/).
# -----------------------------------------------------------------------------
HELM_SET_ARGS=()
if [ "$SKIP_COPILOT" = false ]; then
  HELM_SET_ARGS+=(
    --set "workers.coderAcpCopilot.enabled=true"
    --set "workers.coderAcpCopilot.image.registry=$ACR_LOGIN_SERVER"
    --set "workers.coderAcpCopilot.image.tag=$IMAGE_TAG"
  )
fi
if [ "$SKIP_CLAUDE_CODE" = false ]; then
  HELM_SET_ARGS+=(
    --set "workers.coderAcpClaudeCode.enabled=true"
    --set "workers.coderAcpClaudeCode.image.registry=$ACR_LOGIN_SERVER"
    --set "workers.coderAcpClaudeCode.image.tag=$IMAGE_TAG"
  )
fi

if [ "${#HELM_SET_ARGS[@]}" -gt 0 ]; then
  log "helm upgrade $RELEASE_NAME (enabling workers)"
  if [ -n "$VALUES_FILE" ]; then
    # Re-merge the chart's current values.yaml with the same override file
    # used at install time. This is deliberately NOT `--reuse-values`:
    # that flag freezes the release's previously *computed* values and
    # silently drops any new default key added to values.yaml since install
    # (e.g. workers.<name>.agentVersion/queueName), because the frozen
    # object simply never had that key to begin with.
    helm upgrade "$RELEASE_NAME" "$CHART_PATH" -n "$NAMESPACE" -f "$VALUES_FILE" "${HELM_SET_ARGS[@]}" --wait --timeout 5m
  else
    echo "warning: --values-file not provided; falling back to --reuse-values." >&2
    echo "         This reuses this release's frozen computed values and will NOT" >&2
    echo "         pick up new chart defaults (e.g. agentVersion/queueName) added" >&2
    echo "         to values.yaml since the original install. Re-run with" >&2
    echo "         --values-file <same file you passed to 'helm install -f'> to avoid this." >&2
    helm upgrade "$RELEASE_NAME" "$CHART_PATH" -n "$NAMESPACE" --reuse-values "${HELM_SET_ARGS[@]}" --wait --timeout 5m
  fi

  log "Waiting for worker Deployments to roll out"
  [ "$SKIP_COPILOT" = false ] && kubectl -n "$NAMESPACE" rollout status deployment/"$RELEASE_NAME"-coder-acp-copilot --timeout=5m
  [ "$SKIP_CLAUDE_CODE" = false ] && kubectl -n "$NAMESPACE" rollout status deployment/"$RELEASE_NAME"-coder-acp-claude-code --timeout=5m
fi

# -----------------------------------------------------------------------------
# 4. Register each enabled agent with the API. Uses the *-dev.yaml version
#    manifests shipped in-repo — fine for chart smoke-testing; for a real
#    deployment, register a version manifest whose imageTag/queueName match
#    what you actually built above, and keep
#    workers.<name>.agentVersion (values.yaml) in sync with its agentVersion.
# -----------------------------------------------------------------------------
if [ "$SKIP_AGENT_REGISTRATION" = false ]; then
  start_port_forward
  if [ "$SKIP_COPILOT" = false ]; then
    log "Registering coder-acp-copilot agent"
    "$REPO_ROOT/scripts/register-agent.sh" "$API_URL" \
      apps/workers/coder-acp-copilot/agent.yaml \
      --available true \
      apps/workers/coder-acp-copilot/agent-version.dev.yaml
  fi
  if [ "$SKIP_CLAUDE_CODE" = false ]; then
    log "Registering coder-acp-claude-code agent"
    "$REPO_ROOT/scripts/register-agent.sh" "$API_URL" \
      apps/workers/coder-acp-claude-code/agent.yaml \
      --available true \
      apps/workers/coder-acp-claude-code/agent-version.dev.yaml
  fi
fi

stop_port_forward
trap - EXIT

log "Done."
[ "$SKIP_COPILOT" = false ] && echo "  coder-acp-copilot:      $ACR_LOGIN_SERVER/scope-coder-acp-copilot:$IMAGE_TAG"
[ "$SKIP_CLAUDE_CODE" = false ] && echo "  coder-acp-claude-code:  $ACR_LOGIN_SERVER/scope-coder-acp-claude-code:$IMAGE_TAG"
echo "Check pod status with: kubectl -n $NAMESPACE get pods -l 'app.kubernetes.io/component in (coder-acp-copilot,coder-acp-claude-code)'"
