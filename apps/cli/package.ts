// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const pkg: { version: string; engines: { node: string }; repository: object } = JSON.parse(readFileSync("package.json", "utf8"));
mkdirSync("dist/npm", { recursive: true });
copyFileSync("dist/scope.mjs", "dist/npm/scope.mjs");
chmodSync("dist/npm/scope.mjs", 0o755);
copyFileSync("README.md", "dist/npm/README.md");
copyFileSync("../../LICENSE", "dist/npm/LICENSE");
writeFileSync("dist/npm/package.json", `${JSON.stringify({
  name: "@scope/cli",
  version: pkg.version,
  description: "Scope AI coding agent benchmarking CLI",
  private: true,
  type: "module",
  bin: { scope: "./scope.mjs" },
  files: ["scope.mjs", "README.md", "LICENSE"],
  engines: pkg.engines,
  repository: pkg.repository,
  license: "MIT",
}, null, 2)}\n`);
console.log("Prepared private @scope/cli artifact in dist/npm (workspace remains cli).");
