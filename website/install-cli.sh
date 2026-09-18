#!/usr/bin/env bash
# Scope CLI installer
#
# Usage:
#   gh api repos/microsoft/scope/contents/website/install-cli.sh -H "Accept: application/vnd.github.raw" | bash
#
# Requires: node (>= 20) and either `gh` CLI (authenticated) or GH_TOKEN/GITHUB_TOKEN.
#
# Installs to ~/.local/bin/scope by default. Override with SCOPE_INSTALL_DIR.

set -euo pipefail

REPO="microsoft/scope"
TAG_PREFIX="cli/v"
INSTALL_DIR="${SCOPE_INSTALL_DIR:-$HOME/.local/bin}"
BINARY_NAME="scope"

# --- Helpers ---

info() { printf "\033[1;34m→\033[0m %s\n" "$*"; }
success() { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
error() { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; exit 1; }

# --- Prerequisite checks ---

command -v node >/dev/null 2>&1 || error "Node.js is required (>= 20). Install from https://nodejs.org"

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 20 ]; then
  error "Node.js >= 20 is required (found v$(node --version))"
fi

# Prefer gh CLI if available (handles auth automatically)
if command -v gh >/dev/null 2>&1; then
  HAS_GH=1
else
  HAS_GH=0
  # Need a token for API access to private repo
  TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if [ -z "$TOKEN" ]; then
    error "GitHub token required. Set GH_TOKEN or GITHUB_TOKEN, or install the gh CLI."
  fi
fi

# --- Find latest CLI release (matching cli/v* tag) ---

info "Fetching latest CLI release from $REPO..."

if [ "$HAS_GH" = "1" ]; then
  RELEASE_JSON=$(gh api "repos/$REPO/releases" --paginate 2>/dev/null | node -e "
    const releases = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const match = (Array.isArray(releases) ? releases : []).find(r => (r.tag_name || '').startsWith('${TAG_PREFIX}'));
    if (match) process.stdout.write(JSON.stringify(match));
    else process.exit(1);
  ") || error "No CLI release found (no release with ${TAG_PREFIX}* tag). Run 'gh auth login' if not authenticated."
else
  RELEASE_JSON=$(curl -fsSL \
    -H "Authorization: token $TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/$REPO/releases" 2>/dev/null | node -e "
    const releases = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const match = (Array.isArray(releases) ? releases : []).find(r => (r.tag_name || '').startsWith('${TAG_PREFIX}'));
    if (match) process.stdout.write(JSON.stringify(match));
    else process.exit(1);
  ") || error "No CLI release found. Check your token or create a release with a ${TAG_PREFIX}* tag."
fi

# Parse version and asset URL
VERSION=$(echo "$RELEASE_JSON" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  process.stdout.write((d.tag_name || '').replace(/^cli\/v/, ''));
")
ASSET_URL=$(echo "$RELEASE_JSON" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const asset = (d.assets || []).find(a => a.name === 'scope.mjs');
  if (asset) process.stdout.write(asset.url || '');
")

if [ -z "$VERSION" ]; then
  error "Could not determine latest version"
fi
if [ -z "$ASSET_URL" ]; then
  error "Could not find scope.mjs asset in release $VERSION"
fi

info "Installing scope $VERSION..."

# --- Download ---

mkdir -p "$INSTALL_DIR"

if [ "$HAS_GH" = "1" ]; then
  # gh handles authentication automatically
  gh api "$ASSET_URL" -H "Accept: application/octet-stream" > "$INSTALL_DIR/$BINARY_NAME" 2>/dev/null || \
    error "Failed to download asset"
else
  curl -fsSL \
    -H "Authorization: token $TOKEN" \
    -H "Accept: application/octet-stream" \
    "$ASSET_URL" \
    -o "$INSTALL_DIR/$BINARY_NAME" || error "Failed to download asset"
fi

chmod +x "$INSTALL_DIR/$BINARY_NAME"

# --- Verify ---

INSTALLED_VERSION=$("$INSTALL_DIR/$BINARY_NAME" --version 2>/dev/null) || error "Installation verification failed"
[ -n "$INSTALLED_VERSION" ] || error "Installation verification failed: --version returned empty output"

success "Installed scope $INSTALLED_VERSION to $INSTALL_DIR/$BINARY_NAME"

# --- PATH check ---

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  echo ""
  info "Add $INSTALL_DIR to your PATH:"
  echo ""
  echo "  # Add to ~/.bashrc, ~/.zshrc, or ~/.profile:"
  echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
  echo ""
fi
