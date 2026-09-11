// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { build } from "esbuild";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const app = join(root, "apps/server");
const source = join(app, "assets/source");
const packageJson = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
const require = createRequire(join(root, "packages/shared/package.json"));
await rm(source, { recursive: true, force: true });
await mkdir(source, { recursive: true });

const hash = createHash("sha256");
const excluded = new Set(["node_modules", "dist", "target", "coverage", "ctrf", "playwright-report", "test-results"]);
async function copy(path) {
  const from = join(root, path);
  const to = join(source, path);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  hash.update(path).update(await readFile(to));
  if (path.endsWith("/Dockerfile")) {
    // npm's package metadata endpoint also works with registries that do not
    // implement Corepack's version-specific metadata requests.
    const text = await readFile(from, "utf8");
    const local = text
      .replace(/^(FROM .+)$/gm, "$1\nARG NPM_CONFIG_REGISTRY")
      .replace(/corepack enable && corepack prepare (pnpm@[\w.+-]+) --activate/g, "npm install --global $1");
    await writeFile(`${to}.scope`, local);
    hash.update(`${path}.scope`).update(local);
  }
}
async function walk(directory) {
  for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || excluded.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (path === "apps/server") continue;
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) await copy(path);
    // Never follow symlinks: a package cannot accidentally include files from home.
  }
}
for (const path of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", ".dockerignore", "LICENSE"]) await copy(path);
for (const directory of ["apps", "packages", "config"]) await walk(directory);
await copy("scripts/dev-entrypoint.sh");
const versions = {};
for (const worker of ["coder-acp-copilot", "coder-acp-claude-code"]) {
  const text = await readFile(join(source, "apps/workers", worker, "versions.env"), "utf8");
  for (const line of text.split("\n")) {
    const match = /^([A-Z_]+)=([^\s#]+)$/.exec(line);
    if (match) versions[match[1]] = match[2];
  }
  const agent = require("yaml").parse(await readFile(join(source, "apps/workers", worker, "agent.yaml"), "utf8"));
  await writeFile(join(app, "assets", `${worker}.json`), JSON.stringify(agent) + "\n");
}
await writeFile(join(app, "assets/manifest.json"), JSON.stringify({ version: packageJson.version, digest: hash.digest("hex"), versions }, null, 2) + "\n");
await mkdir(join(app, "dist"), { recursive: true });
const options = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  conditions: ["source"],
  external: Object.keys(packageJson.dependencies),
  alias: { "docker-orchestrator": join(root, "packages/docker-orchestrator/src/index.ts") },
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __scopeCreateRequire } from 'node:module'; const require = __scopeCreateRequire(import.meta.url);" },
};
await build({ ...options, entryPoints: [join(app, "src/cli.ts")], outfile: join(app, "dist/cli.js") });
await build({ ...options, entryPoints: [join(app, "src/host-lifecycle.ts")], outfile: join(app, "dist/host-lifecycle.js") });
for (const worker of ["coder-acp-copilot-host", "coder-acp-claude-code-host"]) {
  await build({
    ...options,
    entryPoints: [join(root, "apps/workers", worker, "src/index.ts")],
    outfile: join(app, "dist", `${worker}.js`),
  });
}
for (const entry of ["cli", "host-lifecycle", "coder-acp-copilot-host", "coder-acp-claude-code-host"]) {
  execFileSync(process.execPath, ["--check", join(app, "dist", `${entry}.js`)], { stdio: "pipe" });
}
await chmod(join(app, "dist/cli.js"), 0o755);
console.log(`Built @scope/server ${packageJson.version} with source assets at ${relative(root, source)}`);
