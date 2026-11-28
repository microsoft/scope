#!/bin/sh
# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

set -eu

PNPM_VERSION=10.29.1
DEFAULT_NPM_REGISTRY=https://registry.npmjs.org

# Normalize only syntax that is safe for both npm and Corepack while keeping the
# complete URL out of diagnostics because it may contain authentication data.
normalize_registry() {
  registry=$1
  setting_name=$2

  case "$registry" in
    http://*|https://*) ;;
    *)
      printf 'Invalid %s: expected an HTTP(S) URL.\n' "$setting_name" >&2
      return 1
      ;;
  esac

  while [ "${registry%/}" != "$registry" ]; do
    registry=${registry%/}
  done

  REGISTRY_URL=$registry node --input-type=module -e '
    const url = new URL(process.env.REGISTRY_URL);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      process.exit(1);
    }
  ' >/dev/null 2>&1 || {
    printf 'Invalid %s: expected a credential-free HTTP(S) URL.\n' "$setting_name" >&2
    return 1
  }

  printf '%s\n' "$registry"
}

# Report only the origin so private endpoint paths stay out of build output.
registry_origin() {
  REGISTRY_URL=$1 node --input-type=module -e '
    const url = new URL(process.env.REGISTRY_URL);
    process.stdout.write(url.origin);
  '
}

npm_registry=$(normalize_registry "${NPM_CONFIG_REGISTRY:-$DEFAULT_NPM_REGISTRY}" NPM_CONFIG_REGISTRY)
npm_registry_origin=$(registry_origin "$npm_registry")
export NPM_CONFIG_REGISTRY=$npm_registry
export npm_config_registry=$npm_registry

if [ -n "${COREPACK_NPM_REGISTRY:-}" ]; then
  corepack_registry=$(normalize_registry "$COREPACK_NPM_REGISTRY" COREPACK_NPM_REGISTRY)
  corepack_registry_origin=$(registry_origin "$corepack_registry")
  export COREPACK_NPM_REGISTRY=$corepack_registry
  printf 'Bootstrapping pnpm %s with explicit Corepack metadata registry origin %s.\n' \
    "$PNPM_VERSION" "$corepack_registry_origin"
else
  unset COREPACK_NPM_REGISTRY
  printf 'Bootstrapping pnpm %s with Corepack default registry; package registry origin is %s.\n' \
    "$PNPM_VERSION" "$npm_registry_origin"
fi

corepack enable
if corepack prepare "pnpm@$PNPM_VERSION" --activate; then
  exit 0
fi

# npm intentionally receives only the ordinary package registry. An explicit
# Corepack metadata override must not share the fallback's failure domain.
printf 'Corepack bootstrap failed; installing pinned pnpm %s from npm package registry origin %s.\n' \
  "$PNPM_VERSION" "$npm_registry_origin" >&2
COREPACK_NPM_REGISTRY= npm install --global "pnpm@$PNPM_VERSION" --force
