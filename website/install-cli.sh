#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

# Compatibility entry point; installation behavior lives in the root installer.
set -euo pipefail

command -v curl >/dev/null || { echo "curl is required." >&2; exit 1; }
temp_dir="$(mktemp -d)"
trap 'rm -f "$temp_dir/install-cli.sh"; rmdir "$temp_dir"' EXIT
curl --fail --silent --show-error --location --retry 3 \
  https://raw.githubusercontent.com/microsoft/scope/main/install-cli.sh \
  --output "$temp_dir/install-cli.sh"
bash "$temp_dir/install-cli.sh"
