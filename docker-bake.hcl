# =============================================================================
# docker-bake.hcl — Parallel image builds for k3d local development
# =============================================================================
# Usage:
#   docker buildx bake                          # Build all services in parallel
#   docker buildx bake api                      # Build a single service
#   docker buildx bake api portal judge         # Build specific services
#
# Override registry / tag:
#   REGISTRY=my-registry:5050 docker buildx bake
#   TAG=my-worktree docker buildx bake
# =============================================================================

variable "REGISTRY" {
  default = "scope-registry.localhost:5050"
}

# Per-worktree image tag — set by k3d-build.sh so each worktree's images stay
# isolated in the shared registry (defaults to "latest" for ad-hoc bakes).
variable "TAG" {
  default = "latest"
}

# Worker version args — sourced from env (k3d-build.sh exports these from versions.env)
variable "COPILOT_CLI_VERSION" {
  default = ""
}

variable "CLAUDE_CODE_ACP_VERSION" {
  default = ""
}

variable "CLAUDE_AGENT_SDK_VERSION" {
  default = ""
}

group "default" {
  targets = [
    "api",
    "judge",
    "portal",
    "token-manager",
    "scheduler",
    "gateway",
    "coder-acp-copilot",
    "coder-acp-claude-code",
  ]
}

# --- Application services ---

target "api" {
  dockerfile = "apps/api/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/api:${TAG}"]
}

target "judge" {
  dockerfile = "apps/judge/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/judge:${TAG}"]
}

target "portal" {
  dockerfile = "apps/portal/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/portal:${TAG}"]
}

target "token-manager" {
  dockerfile = "apps/token-manager/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/token-manager:${TAG}"]
}

target "scheduler" {
  dockerfile = "apps/scheduler/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/scheduler:${TAG}"]
}

target "gateway" {
  dockerfile = "Dockerfile"
  context    = "apps/gateway"
  target     = "runtime"
  tags       = ["${REGISTRY}/scoped/gateway:${TAG}"]
}

# --- Worker services ---

target "coder-acp-copilot" {
  dockerfile = "apps/workers/coder-acp-copilot/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/coder-acp-copilot:${TAG}"]
  args = {
    COPILOT_CLI_VERSION = "${COPILOT_CLI_VERSION}"
  }
}

target "coder-acp-claude-code" {
  dockerfile = "apps/workers/coder-acp-claude-code/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/coder-acp-claude-code:${TAG}"]
  args = {
    CLAUDE_CODE_ACP_VERSION  = "${CLAUDE_CODE_ACP_VERSION}"
    CLAUDE_AGENT_SDK_VERSION = "${CLAUDE_AGENT_SDK_VERSION}"
  }
}
