// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { existsSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { resolve } from "node:path";
import { resolveDevConfig } from "./config.js";
import { execute, loadInputs, root, stateDirectory } from "./control.js";

async function check(url: URL, ca: Buffer, bearer?: string): Promise<{ status: number; body: string }> {
  if (url.protocol === "http:") {
    const response = await fetch(url, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.text() };
  }
  return new Promise((resolvePromise, reject) => {
    const req = request(url, { ca, headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, timeout: 10_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => resolvePromise({ status: response.statusCode || 0, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Smoke request timed out")));
    req.end();
  });
}

async function main(): Promise<void> {
  const mode = process.argv.find((argument) => argument.startsWith("--mode="))?.slice(7) || "native";
  if (mode !== "native" && mode !== "kind") throw new Error("Smoke mode must be native or kind");
  const statePath = resolve(stateDirectory, "mode.json");
  if (existsSync(statePath)) {
    const state: { active?: boolean } = JSON.parse(readFileSync(statePath, "utf8"));
    if (state.active) throw new Error("Run dev:down before smoke testing; active development resources will not be taken over");
  }
  const inputs = loadInputs();
  const config = resolveDevConfig({ ...inputs.generated, ...inputs.local, ...inputs.process });
  const origin = new URL(`${config.codespaces ? "http" : "https"}://localhost:${config.edgePort}`);
  const started = Date.now();
  try {
    execute("pnpm", ["dev:up", `--mode=${mode}`, "--services=api,portal", ...(process.argv.includes("--build") ? ["--build"] : [])], process.env, root, 0);
    const ca = readFileSync(resolve(root, ".dev-state/spike/certs/rootCA.pem"));
    for (const path of ["/health", "/ready", "/"]) {
      const response = await check(new URL(path, origin), ca);
      if (response.status !== 200 || (path === "/" && !response.body.includes("<html"))) throw new Error(`Edge smoke failed at ${path}: HTTP ${response.status}`);
    }
    const denied = await check(new URL("/api/v1/users/me", origin), ca, "invalid-smoke-bearer");
    if (denied.status !== 401) throw new Error(`Invalid IdP bearer was not rejected: HTTP ${denied.status}`);
    console.log(`${mode} credential-free smoke passed in ${((Date.now() - started) / 1000).toFixed(1)}s. Browser PKCE/private forwarding and live providers remain separate gates.`);
  } finally {
    execute("pnpm", ["dev:down"], process.env, root, 0);
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });