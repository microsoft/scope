#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

set -euo pipefail

command -v node >/dev/null || { echo "Node.js >= 20 is required." >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required." >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) { console.error("Node.js >= 20 is required."); process.exit(1); }'

tag="$(curl --fail --silent --show-error --location --retry 3 \
  https://api.github.com/repos/microsoft/scope/releases | node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const releases = JSON.parse(input);
      if (!Array.isArray(releases)) throw new Error("Invalid GitHub release response");
      const release = releases.find(item => !item.draft && !item.prerelease && /^cli\/v\d+\.\d+\.\d+$/.test(item.tag_name));
      if (!release) { console.error("No published Scope CLI release is available in microsoft/scope."); process.exit(1); }
      console.log(release.tag_name);
    });
  ')"

install_dir="${SCOPE_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$install_dir"
temp_dir="$(mktemp -d "$install_dir/.scope-install.XXXXXX")"
trap 'rm -f "$temp_dir/scope.mjs"; rmdir "$temp_dir"' EXIT
curl --fail --silent --show-error --location --retry 3 \
  "https://github.com/microsoft/scope/releases/download/cli%2Fv${tag#cli/v}/scope.mjs" \
  --output "$temp_dir/scope.mjs"
version="$(SCOPE_NO_UPDATE_CHECK=1 node "$temp_dir/scope.mjs" --version)"
if [ "$version" != "${tag#cli/v}" ]; then
  echo "Downloaded bundle version does not match $tag." >&2
  exit 1
fi
chmod 755 "$temp_dir/scope.mjs"
mv "$temp_dir/scope.mjs" "$install_dir/scope"
echo "Installed scope $version to $install_dir/scope"
echo "Ensure $install_dir is on your PATH."
