// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { createServer } from "node:net";
import { cpus, freemem, totalmem } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { renderEdgeRoutes, resolveDevConfig } from "./config.js";

export const ENTRA_IMAGE = "ghcr.io/cmaneu/entra-local@sha256:70584ef110914d100409cb3d63a63548ccdde10ca780f9751755f1482dec5d7e";

/** Hash the workspace path so operations cannot address another worktree's state. */
export function workspaceName(root: string): string {
  return `scope-spike-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
}

interface JsonResponse {
  status: number;
  body: unknown;
}

/** Retry bounded, idempotent bootstrap operations; reject permanent HTTP failures. */
export async function registerRedirect(send: () => Promise<JsonResponse>, pause: (milliseconds: number) => Promise<void> = delay): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let response: JsonResponse | undefined;
    try {
      response = await send();
    } catch (error) {
      if (attempt === 4) throw error;
    }
    if (response?.status === 201 || response?.status === 409) return;
    if (response && response.status !== 429 && response.status < 500) {
      throw new Error(`Redirect registration rejected: HTTP ${response.status}`);
    }
    if (attempt === 4) throw new Error("Redirect registration exhausted five attempts");
    await pause(Math.min(500 * 2 ** attempt, 4000));
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

/** Verify discovery and every selected-key issuer without weakening API checks. */
export function verifyMetadata(discovery: unknown, jwks: unknown, origin: string, tenant: string): void {
  const metadata = record(discovery);
  const issuer = `${origin}/${tenant}/v2.0`;
  if (metadata.issuer !== issuer) throw new Error("Discovery issuer mismatch");
  for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri", "end_session_endpoint", "userinfo_endpoint"]) {
    if (typeof metadata[field] !== "string" || new URL(metadata[field]).origin !== origin) {
      throw new Error(`Unreachable/external discovery endpoint: ${field}`);
    }
  }
  const keys = record(jwks).keys;
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((key: unknown) => record(key).issuer === issuer)) {
    throw new Error("Missing or inconsistent JWK issuer metadata");
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  execFileSync(command, args, { stdio: "inherit", env, timeout: 300_000 });
}

function output(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", timeout: 30_000 }).trim();
}

/** Reserve the exact advertised port before starting, rather than silently shifting it. */
async function assertFreePort(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Port ${port} is occupied; configure an explicit port override`)));
    server.listen(port, "0.0.0.0", () => server.close((error) => error ? reject(error) : resolvePromise()));
  });
}

async function main(): Promise<void> {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const state = resolve(root, ".dev-state/spike");
  const name = workspaceName(root);
  const config = resolveDevConfig(process.env);
  const entraPort = Number(process.env.SPIKE_ENTRA_PORT || "18443");
  if (!Number.isInteger(entraPort) || entraPort < 1024 || entraPort > 65535 || entraPort === config.edgePort) {
    throw new Error("SPIKE_ENTRA_PORT must be a distinct port between 1024 and 65535");
  }
  const certDir = resolve(state, "certs");
  const caDir = resolve(state, "authority");
  const edgeConfig = resolve(state, "edge.conf");
  const internalOrigin = `https://localhost:${entraPort}`;
  const routes = renderEdgeRoutes(config, {
    api: `http://localhost:${process.env.API_PORT || "3100"}`, portal: `http://localhost:${process.env.PORTAL_PORT || "5100"}`, entra: internalOrigin,
  });
  const env = {
    ...process.env,
    ...config.auth,
    AUTH_TENANT_ID: config.tenant,
    SPIKE_ENTRA_PORT: String(entraPort),
    SPIKE_CERT_DIR: certDir,
    SPIKE_EDGE_CONFIG: edgeConfig,
    COMPOSE_PARALLEL_LIMIT: "2",
    CAROOT: caDir,
  };
  const compose = (...args: string[]) => run("docker", ["compose", "--project-name", name, "--env-file", "/dev/null", "--file", resolve(root, ".devcontainer/spike/compose.yaml"), ...args], env);
  const command = process.argv[2] || "doctor";

  if (command === "doctor") {
    console.log(`Phase-one spike only: ${name}\nOrigin: ${config.publicOrigin}\nTransport: ${config.codespaces ? "HTTP behind GitHub HTTPS" : "local HTTPS"}`);
    console.log(`CPUs: ${cpus().length}; RAM: ${(totalmem() / 2 ** 30).toFixed(1)} GiB; free RAM: ${(freemem() / 2 ** 30).toFixed(1)} GiB`);
    for (const [tool, args] of [["node", ["--version"]], ["pnpm", ["--version"]], ["mkcert", ["-version"]], ["kind", ["version"]], ["kubectl", ["version", "--client"]], ["docker", ["info", "--format", "{{.ServerVersion}}"]]] as const) {
      try { console.log(`${tool}: ${output(tool, [...args])}`); }
      catch { process.exitCode = 1; console.error(`UNAVAILABLE: ${tool}`); }
    }
    console.log(`Copilot process credential: ${process.env.GITHUB_TOKEN || process.env.GH_TOKEN ? "present, entitlement unverified" : "not supplied (stored token-manager credentials not inspected)"}`);
    console.log(`Anthropic process credential: ${process.env.ANTHROPIC_API_KEY ? "present, entitlement unverified" : "not supplied"}`);
    console.log(`Azure inference process credentials: ${process.env.AZURE_AI_INFERENCE_ENDPOINT && process.env.AZURE_AI_INFERENCE_API_KEY ? "present, entitlement unverified" : "not supplied"}`);
    console.log("No provider calls are made; these checks do not prove live access.");
    if (process.env.SCOPE_DIND_SPIKE !== "1") console.warn("DinD topology NOT VERIFIED: reopen in the provided privileged devcontainer before testing namespace/bind-mount assumptions.");
    run("df", ["-h", root]);
    return;
  }

  if (command === "config") {
    mkdirSync(state, { recursive: true, mode: 0o700 });
    writeFileSync(edgeConfig, routes);
    writeFileSync(resolve(state, "public.json"), JSON.stringify({ ...config, auth: { ...config.auth, AUTH_JWKS_URI: `${internalOrigin}/${config.tenant}/discovery/v2.0/keys` } }, null, 2));
    console.log(`Generated non-secret settings in ${state}; .env and .env.local were not read or modified.`);
    return;
  }

  if (command === "down") { compose("down", "--remove-orphans", "--timeout", "20"); return; }
  if (command === "logs") { compose("logs", "--tail", "100"); return; }
  if (command === "reset-data") {
    if (process.argv[3] !== `--confirm=${name}`) throw new Error(`Destructive reset requires --confirm=${name}; only this spike's emulator data and staged certificates will be removed`);
    compose("down", "--volumes", "--remove-orphans", "--timeout", "20");
    return;
  }

  if (command === "kind-up" || command === "kind-down") {
    if (process.env.SCOPE_DIND_SPIKE !== "1") throw new Error("Kind spike requires reopening in the provided DinD devcontainer");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const kubeconfig = resolve(state, "kubeconfig");
    if (command === "kind-down") { run("kind", ["delete", "cluster", "--name", name, "--kubeconfig", kubeconfig]); return; }
    await assertFreePort(8080);
    run("kind", ["create", "cluster", "--name", name, "--kubeconfig", kubeconfig, "--config", resolve(root, ".devcontainer/kind/cluster.yaml"), "--wait", "120s"]);
    run("kubectl", ["--kubeconfig", kubeconfig, "--context", `kind-${name}`, "get", "--raw", "/readyz"]);
    console.log("Kind API ready. This spike deploys no application workloads; do not mark full-Kind acceptance complete.");
    return;
  }

  if (command !== "up" && command !== "probe") throw new Error("Usage: pnpm dev:spike doctor|config|up|probe|down|logs|reset-data|kind-up|kind-down");
  if (!existsSync(edgeConfig)) throw new Error("Run pnpm dev:spike config first");
  if (readFileSync(edgeConfig, "utf8") !== routes) throw new Error("Origin or port settings changed: stop the spike, regenerate config, and restart both dev-edge and Vite");
  if (command === "up") {
    if (process.env.SCOPE_DIND_SPIKE !== "1") throw new Error("Spike startup requires reopening in the provided DinD devcontainer");
    await assertFreePort(config.edgePort);
    await assertFreePort(entraPort);
    mkdirSync(certDir, { recursive: true, mode: 0o700 });
    mkdirSync(caDir, { recursive: true, mode: 0o700 });
    run("mkcert", ["-cert-file", resolve(certDir, "edge.pem"), "-key-file", resolve(certDir, "edge-key.pem"), new URL(config.publicOrigin).hostname, "localhost", "entra-local"], env);
    copyFileSync(resolve(caDir, "rootCA.pem"), resolve(certDir, "rootCA.pem"));
    compose("up", "--detach", "--wait", "--wait-timeout", "120");
  }

  const ca = readFileSync(resolve(certDir, "rootCA.pem"));
  const send = (path: string, body?: string): Promise<JsonResponse> => new Promise((resolvePromise, reject) => {
    const req = request(`${internalOrigin}${path}`, { ca, method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, timeout: 5000 }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("error", reject);
      response.on("end", () => {
        try { const parsed: unknown = JSON.parse(text); resolvePromise({ status: response.statusCode || 0, body: parsed }); }
        catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Entra request timed out")));
    req.end(body);
  });
  await registerRedirect(() => send("/admin/api/apps/cccccccc-0000-0000-0000-000000000001/redirectUris", JSON.stringify({ uri: config.publicOrigin, type: "spa" })));
  const discovery = await send(`/${config.tenant}/v2.0/.well-known/openid-configuration`);
  const jwks = await send(`/${config.tenant}/discovery/v2.0/keys`);
  if (discovery.status !== 200 || jwks.status !== 200) throw new Error("Metadata endpoints are not ready");
  verifyMetadata(discovery.body, jwks.body, config.publicOrigin, config.tenant);
  const curlArgs = ["--silent", "--show-error", "--max-time", "5", "--cacert", resolve(certDir, "rootCA.pem")];
  const edgeOrigin = `${config.codespaces ? "http" : "https"}://localhost:${config.edgePort}`;
  const edgeDiscovery: unknown = JSON.parse(output("curl", [...curlArgs, "--fail", `${edgeOrigin}/${config.tenant}/v2.0/.well-known/openid-configuration`]));
  verifyMetadata(edgeDiscovery, jwks.body, config.publicOrigin, config.tenant);
  for (const path of ["/admin/api/apps", "/graph/unknown", "/wrong-tenant/oauth2/v2.0/token"]) {
    const status = output("curl", [...curlArgs, "--output", "/dev/null", "--write-out", "%{http_code}", `${edgeOrigin}${path}`]);
    if (status !== "404") throw new Error(`dev-edge must deny ${path}, got HTTP ${status}`);
  }
  console.log(`Internal TLS, exact redirect registration, edge discovery, denied routes and JWK issuers verified.\nBrowser: ${config.publicOrigin}\nPKCE, logout allowlisting, API enrollment and private forwarding: STILL REQUIRE BROWSER VALIDATION.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}