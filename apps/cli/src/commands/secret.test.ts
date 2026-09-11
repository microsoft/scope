// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registerSecretCommands } from "./secret.js";
import { ScopeCommand } from "../utils/connection.js";
import { EnvironmentStore } from "../utils/environments.js";
import { resetApiClient, setApiLogSink, type ApiLogEntry } from "../utils/api-client.js";

const isolated = vi.hoisted(() => ({
  directory: `${process.cwd()}/apps/cli/.test-secret-config-${process.pid}`,
  stdin: "piped-provider-credential\n",
}));
vi.mock("node:os", async (original) => ({
  ...await original<typeof import("node:os")>(),
  homedir: () => isolated.directory,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => args[0] === 0 ? isolated.stdin : fs.readFileSync(...args),
  };
});

interface CapturedRequest { url: string; token: string | null; method: string; body: string }
let requests: CapturedRequest[];
let reply: (request: Request) => Response;
const metadata = { _id: "key-id", type: "openai-api-key", enabled: true, lastValidationStatus: "unknown", capabilities: [] };
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
async function run(...args: string[]): Promise<void> {
  const program = new ScopeCommand().option("--env <name>").exitOverride();
  registerSecretCommands(program);
  await program.parseAsync(args, { from: "user" });
}
beforeEach(() => {
  rmSync(isolated.directory, { recursive: true, force: true });
  mkdirSync(isolated.directory, { recursive: true });
  vi.stubEnv("XDG_CONFIG_HOME", join(isolated.directory, "config"));
  vi.stubEnv("LOCALAPPDATA", join(isolated.directory, "appdata"));
  vi.stubEnv("SCOPE_TOKEN", "ambient-scope-token");
  const store = new EnvironmentStore();
  store.add("local", "http://127.0.0.1:43127", "named-scope-token");
  store.use("local");
  resetApiClient();
  requests = [];
  reply = () => json(metadata);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    requests.push({ url: request.url, token: request.headers.get("authorization"), method: request.method, body: await request.clone().text() });
    return reply(request);
  }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  resetApiClient();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(isolated.directory, { recursive: true, force: true });
});

describe("provider secret CLI", () => {
  it.each([
    ["openai-api-key", "https://api.openai.com/v1", "gpt-4.1"],
    ["openrouter-api-key", "https://openrouter.ai/api/v1", "openai/gpt-4.1"],
  ])("creates %s with its preset and keeps provider credentials out of Scope authentication", async (type, endpoint, model) => {
    await run("secret", "create", "--type", type, "--api-key", "provider-credential", "--comment", "Portal authoring");
    const body: { type: string; value: string; comment: string } = JSON.parse(requests[0].body);
    expect(body.type).toBe(type);
    expect(JSON.parse(body.value)).toEqual({ endpoint, apiKey: "provider-credential", model });
    expect(body.comment).toBe("Portal authoring");
    expect(requests[0]).toMatchObject({ url: "http://127.0.0.1:43127/api/v1/keys", token: "Bearer named-scope-token", method: "POST" });
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).not.toContain("provider-credential");
  });

  it("reads a compatible key from isolated stdin with an explicit endpoint/model", async () => {
    await run("secret", "create", "--type", "openai-compatible", "--api-key-stdin", "--endpoint", "http://localhost:11434/v1", "--model", "local-model");
    const body: { value: string } = JSON.parse(requests[0].body);
    expect(JSON.parse(body.value)).toEqual({ endpoint: "http://localhost:11434/v1", apiKey: "piped-provider-credential", model: "local-model" });
  });

  it.each([
    ["--type", "openai-compatible", "--api-key", "fixture", "--endpoint", "http://remote.example/v1", "--model", "model"],
    ["--type", "openai-compatible", "--api-key", "fixture", "--endpoint", "https://endpoint.example/v1"],
    ["--type", "openai-api-key", "--api-key", "fixture", "--value", "other"],
    ["--type", "openai-api-key", "--value", "{}", "--model", "model"],
    ["--type", "unknown", "--api-key", "fixture"],
  ])("rejects invalid credential input before sending it: %s", async (...args) => {
    await expect(run("secret", "create", ...args)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("preserves raw Anthropic and existing Foundry registration formats", async () => {
    await run("secret", "create", "--type", "anthropic-api-key", "--value", "anthropic-fixture", "-u", "https://explicit.example");
    expect(JSON.parse(requests[0].body)).toMatchObject({ type: "anthropic-api-key", value: "anthropic-fixture" });
    expect(requests[0].token).toBe("Bearer ambient-scope-token");
    await run("secret", "create", "--type", "azure-ai-foundry", "--api-key", "foundry-fixture", "--endpoint", "https://resource.services.ai.azure.com/models");
    const body: { value: string } = JSON.parse(requests[1].body);
    expect(JSON.parse(body.value)).toEqual({ endpoint: "https://resource.services.ai.azure.com/models", apiKey: "foundry-fixture" });
  });

  it("never records credential request or response bodies in the API log sink", async () => {
    const entries: ApiLogEntry[] = [];
    setApiLogSink({ record: (entry) => entries.push(entry) });
    reply = () => json({ ...metadata, value: "provider-credential" });
    await run("secret", "create", "--type", "openai-api-key", "--api-key", "provider-credential", "-o", "json");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ requestBody: "[REDACTED]", responseBody: "[REDACTED]" });
    expect(JSON.stringify(entries)).not.toContain("provider-credential");
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).not.toContain("provider-credential");
  });

  it("lists/gets metadata, updates metadata, previews/validates and deletes through the same API", async () => {
    reply = () => json([metadata]);
    await run("secret", "list", "--capability", "openai-api", "-o", "json");
    expect(requests[0].url).toContain("/keys?capability=openai-api");
    reply = () => json(metadata);
    await run("secret", "get", "key-id");
    await run("secret", "update", "key-id", "--disable", "--clear-expiry", "--comment", "");
    expect(JSON.parse(requests[2].body)).toEqual({ enabled: false, expiresAt: null, comment: null });
    reply = () => json({ status: "valid", capabilities: ["openai-api"] });
    await run("secret", "preview", "--type", "openai-api-key", "--api-key", "fixture");
    reply = () => json({ ...metadata, lastValidationStatus: "valid", capabilities: ["openai-api"] });
    await run("secret", "validate", "key-id");
    expect(vi.mocked(console.log).mock.calls.at(-1)?.[0]).toContain("valid");
    reply = () => new Response(null, { status: 204 });
    await run("secret", "delete", "key-id");
    expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "PUT", "POST", "POST", "DELETE"]);
    expect(requests.every((request) => request.token === "Bearer named-scope-token")).toBe(true);
  });

  it("does not replay key registration after a transient server failure", async () => {
    reply = () => json({ error: "Registration unavailable" }, 503);
    await expect(run("secret", "create", "--type", "openai-api-key", "--api-key", "fixture")).rejects.toThrow("Registration unavailable");
    expect(requests).toHaveLength(1);
  });

  it("retries ky-wrapped network failures for metadata reads", async () => {
    reply = () => {
      if (requests.length === 1) throw new TypeError("fetch failed");
      return json([metadata]);
    };
    await run("secret", "list", "-o", "json");
    expect(requests.map(request => request.method)).toEqual(["GET", "GET"]);
    expect(requests[0].url).toBe(requests[1].url);
  });

  it("does not replay credential registration after a network failure", async () => {
    reply = () => { throw new TypeError("fetch failed"); };
    await expect(run("secret", "create", "--type", "openai-api-key", "--api-key", "fixture")).rejects.toThrow();
    expect(requests.map(request => request.method)).toEqual(["POST"]);
  });
});

describe("Portal AI selection CLI", () => {
  it("reads defaults, pins a provider/key/model and resets to auto without credential values", async () => {
    reply = () => json({ provider: "auto" });
    await run("secret", "portal-ai", "show", "-o", "json");
    reply = () => json({ provider: "openrouter", keyId: "key-id", model: "openai/gpt-4.1" });
    await run("secret", "portal-ai", "set", "openrouter", "--key-id", "key-id", "--model", "openai/gpt-4.1");
    expect(requests[1]).toMatchObject({ url: "http://127.0.0.1:43127/api/v1/keys/portal-ai", method: "PUT" });
    expect(JSON.parse(requests[1].body)).toEqual({ provider: "openrouter", keyId: "key-id", model: "openai/gpt-4.1" });
    reply = () => json({ provider: "auto" });
    await run("--env", "missing", "secret", "portal-ai", "set", "auto", "-u", "https://explicit.example");
    expect(requests[2].token).toBe("Bearer ambient-scope-token");
    expect(JSON.parse(requests[2].body)).toEqual({ provider: "auto" });
  });

  it.each([
    ["auto", "--key-id", "key-id"], ["auto", "--model", "model"], ["unknown"], ["openai", "--model", ""],
  ])("rejects invalid selection before mutation: %s", async (...args) => {
    await expect(run("secret", "portal-ai", "set", ...args)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});
