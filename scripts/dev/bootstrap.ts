// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { request } from "node:https";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { registerRedirect, verifyMetadata } from "./spike.js";
import { DEFAULT_TENANT, SPA_CLIENT_ID } from "./config.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const shared = createRequire(resolve(root, "packages/shared/package.json"));

/** Use one capped retry layer for idempotent emulator bootstrap operations. */
export async function retry<T>(operation: () => Promise<T>, attempts = 30): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt + 1 >= attempts || (error instanceof Error && error.message.startsWith("Permanent HTTP"))) throw error;
      await delay(Math.min(250 * 2 ** attempt, 2000));
    }
  }
}

async function postJson(path: string, body: unknown): Promise<void> {
  await retry(async () => {
    const response = await fetch(`${process.env.API_ENDPOINT || "http://api:80"}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`${response.status < 500 && response.status !== 429 ? "Permanent HTTP" : "HTTP"} ${response.status} for ${path}`);
  });
}

export async function bootstrap(command: string): Promise<void> {
  if (command === "storage-init") {
    type StorageOptions = { retryOptions: { maxTries: number; tryTimeoutInMs: number } };
    const { BlobServiceClient } = shared("@azure/storage-blob") as { BlobServiceClient: { fromConnectionString(connection: string, options: StorageOptions): { getContainerClient(name: string): { createIfNotExists(): Promise<unknown> } } } };
    const { QueueServiceClient } = shared("@azure/storage-queue") as { QueueServiceClient: { fromConnectionString(connection: string, options: StorageOptions): { getQueueClient(name: string): { createIfNotExists(): Promise<unknown> } } } };
    const connection = process.env.STORAGE_CONNECTION_STRING;
    if (!connection) throw new Error("STORAGE_CONNECTION_STRING is required");
    const options = { retryOptions: { maxTries: 1, tryTimeoutInMs: 10_000 } };
    const blobs = BlobServiceClient.fromConnectionString(connection, options);
    const queues = QueueServiceClient.fromConnectionString(connection, options);
    for (const name of ["har", "logs", "snapshots", "task-prompts", "skills", "codebases", "resources"]) await retry(() => blobs.getContainerClient(name).createIfNotExists());
    for (const name of ["queue-coder-acp-copilot", "queue-coder-acp-claude-code", "report-queue", "post-processor-queue"]) await retry(() => queues.getQueueClient(name).createIfNotExists());
    return;
  }
  if (command === "db-migrate") {
    execFileSync("pnpm", ["--filter", "db-migrations", "migrate:up"], { cwd: root, stdio: "inherit", timeout: 300_000 });
    return;
  }
  if (command === "register-agents") {
    const { parse } = shared("yaml") as { parse(source: string): unknown };
    for (const name of ["coder-acp-copilot", "coder-acp-claude-code"]) {
      const directory = resolve(root, "apps/workers", name);
      const agent: unknown = parse(readFileSync(resolve(directory, "agent.yaml"), "utf8"));
      if (!agent || typeof agent !== "object") throw new Error(`Invalid agent manifest ${name}`);
      await postJson("/api/v1/agents", { ...agent, available: false });
      const version: unknown = parse(readFileSync(resolve(directory, "agent-version.dev.yaml"), "utf8"));
      await postJson(`/api/v1/agents/${name}/versions`, version);
    }
    return;
  }
  if (command === "redirect-init") {
    const origin = process.env.PUBLIC_ORIGIN;
    if (!origin) throw new Error("PUBLIC_ORIGIN is required");
    const tenant = process.env.AUTH_TENANT_ID || DEFAULT_TENANT;
    const ca = readFileSync(process.env.NODE_EXTRA_CA_CERTS || "/ca/rootCA.pem");
    const internal = process.env.ENTRA_INTERNAL_ORIGIN || "https://entra-local:8443";
    const send = (path: string, body?: string): Promise<{ status: number; body: unknown }> => new Promise((resolvePromise, reject) => {
      const req = request(`${internal}${path}`, { ca, method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, timeout: 5000 }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { text += chunk; });
        response.on("error", reject);
        response.on("end", () => { try { const body: unknown = JSON.parse(text); resolvePromise({ status: response.statusCode || 0, body }); } catch (error) { reject(error); } });
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("Entra bootstrap timed out")));
      req.end(body);
    });
    await registerRedirect(() => send(`/admin/api/apps/${SPA_CLIENT_ID}/redirectUris`, JSON.stringify({ uri: origin, type: "spa" })));
    const discovery = await retry(() => send(`/${tenant}/v2.0/.well-known/openid-configuration`));
    const keys = await retry(() => send(`/${tenant}/discovery/v2.0/keys`));
    verifyMetadata(discovery.body, keys.body, origin, tenant);
    return;
  }
  throw new Error(`Unknown initialization target: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bootstrap(process.argv[2]).catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}