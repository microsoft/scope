// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registerSecretCommands } from "./secret.js";
import { Command } from "commander";
import { resetApiClient, setApiLogSink, type ApiLogEntry } from "../utils/api-client.js";
import type { OutputFormat } from "../utils/types.js";

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
const metadata = { _id: "key-id", type: "azure-ai-foundry", enabled: true, lastValidationStatus: "unknown", capabilities: ["azure-ai-inference"] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function run(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerSecretCommands(program);
  await program.parseAsync(args, { from: "user" });
}

beforeEach(() => {
  rmSync(isolated.directory, { recursive: true, force: true });
  mkdirSync(isolated.directory, { recursive: true });
  vi.stubEnv("XDG_CONFIG_HOME", join(isolated.directory, "config"));
  vi.stubEnv("LOCALAPPDATA", join(isolated.directory, "appdata"));
  vi.stubEnv("SCOPE_API_URL", "http://127.0.0.1:43127");
  vi.stubEnv("SCOPE_TOKEN", "scope-token");
  resetApiClient();
  requests = [];
  reply = () => json(metadata);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    requests.push({ url: request.url, token: request.headers.get("authorization"), method: request.method, body: await request.clone().text() });
    return reply(request);
  }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  resetApiClient();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(isolated.directory, { recursive: true, force: true });
});

describe("secret CLI", () => {
  it("creates an Azure AI Foundry key from structured flags", async () => {
    await run("secret", "create", "--type", "azure-ai-foundry", "--api-key", "foundry-fixture", "--endpoint", "https://resource.services.ai.azure.com/models", "--comment", "Portal authoring");

    const body: { type: string; value: string; comment: string } = JSON.parse(requests[0].body);
    expect(body.type).toBe("azure-ai-foundry");
    expect(JSON.parse(body.value)).toEqual({ endpoint: "https://resource.services.ai.azure.com/models", apiKey: "foundry-fixture" });
    expect(body.comment).toBe("Portal authoring");
    expect(requests[0]).toMatchObject({ url: "http://127.0.0.1:43127/api/v1/keys", method: "POST" });
    expect(requests[0].token).not.toBeNull();
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).not.toContain("foundry-fixture");
  });

  it("reads a Foundry API key from isolated stdin", async () => {
    await run("secret", "create", "--type", "azure-ai-foundry", "--api-key-stdin", "--endpoint", "https://resource.services.ai.azure.com/models", "--model", "gpt-4.1");

    const body: { value: string } = JSON.parse(requests[0].body);
    expect(JSON.parse(body.value)).toEqual({ endpoint: "https://resource.services.ai.azure.com/models", apiKey: "piped-provider-credential", model: "gpt-4.1" });
  });

  it.each([
    ["--type", "azure-ai-foundry", "--api-key", "fixture"],
    ["--type", "github-oauth", "--api-key", "fixture", "--endpoint", "https://endpoint.example/v1"],
    ["--type", "azure-ai-foundry", "--api-key", "fixture", "--value", "other"],
    ["--type", "unknown", "--api-key", "fixture"],
  ])("rejects invalid credential input before sending it: %s", async (...args) => {
    await expect(run("secret", "create", ...args)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("preserves raw Anthropic registration format", async () => {
    await run("secret", "create", "--type", "anthropic-api-key", "--value", "anthropic-fixture", "-u", "https://explicit.example");

    expect(JSON.parse(requests[0].body)).toMatchObject({ type: "anthropic-api-key", value: "anthropic-fixture" });
    expect(requests[0].token).not.toBeNull();
  });

  it("warns when secrets are passed through argv", async () => {
    await run("secret", "create", "--type", "anthropic-api-key", "--value", "anthropic-fixture");
    await run("secret", "create", "--type", "azure-ai-foundry", "--api-key", "foundry-fixture", "--endpoint", "https://resource.services.ai.azure.com/models");

    const stderr = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(stderr).toContain("--value exposes secrets");
    expect(stderr).toContain("--api-key exposes secrets");
    expect(stderr).toContain("--value-stdin");
    expect(stderr).toContain("--api-key-stdin");
  });

  it("never records credential request or response bodies in the API log sink", async () => {
    const entries: ApiLogEntry[] = [];
    setApiLogSink({ record: (entry) => entries.push(entry) });
    reply = () => json({ ...metadata, value: "provider-credential" });

    await run("secret", "create", "--type", "azure-ai-foundry", "--api-key", "provider-credential", "--endpoint", "https://resource.services.ai.azure.com/models", "-o", "json");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ requestBody: "[REDACTED]", responseBody: "[REDACTED]" });
    expect(JSON.stringify(entries)).not.toContain("provider-credential");
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).not.toContain("provider-credential");
  });

  it.each(["table", "json", "yaml", "tsv"] as OutputFormat[])("never prints secret values in %s output", async (output) => {
    const leaked = "leaked-secret-value";
    reply = (request) => {
      if (request.url.endsWith("/keys")) return json([{ ...metadata, value: leaked }]);
      if (request.url.endsWith("/keys/preview")) return json({ status: "valid", capabilities: ["azure-ai-inference"], value: leaked });
      return json({ ...metadata, value: leaked });
    };

    await run("secret", "list", "-o", output);
    await run("secret", "get", "key-id", "-o", output);
    await run("secret", "create", "--type", "azure-ai-foundry", "--api-key", "input-secret-value", "--endpoint", "https://resource.services.ai.azure.com/models", "-o", output);
    await run("secret", "preview", "--type", "azure-ai-foundry", "--api-key", "input-secret-value", "--endpoint", "https://resource.services.ai.azure.com/models", "-o", output);
    await run("secret", "update", "key-id", "--disable", "-o", output);
    await run("secret", "validate", "key-id", "-o", output);

    const stdout = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(stdout).not.toContain(leaked);
    expect(stdout).not.toContain("input-secret-value");
  });

  it("never prints a secret value in any output format, even if the API returns one", async () => {
    // Defence in depth: KeyDocument stores only a Key Vault secretName, the CLI
    // projects a fixed metadata allowlist, and formatAsJSON rebuilds rows from
    // that allowlist. Pin the guarantee so a future field addition cannot leak a
    // credential through an output formatter.
    const leaked = "sk-SHOULD-NEVER-BE-PRINTED";
    const withValue = { ...metadata, value: leaked, secretName: "token-azure-ai-foundry-key-id" };
    const formats: OutputFormat[] = ["table", "json", "yaml", "tsv"];
    for (const format of formats) {
      reply = () => json([withValue]);
      await run("secret", "list", "-o", format);
      reply = () => json(withValue);
      await run("secret", "get", "key-id", "-o", format);
      reply = () => json(withValue);
      await run("secret", "validate", "key-id", "-o", format);
    }
    const printed = vi.mocked(console.log).mock.calls.map((call) => String(call[0])).join("\n");
    expect(printed).not.toContain(leaked);
    expect(printed).not.toContain("secretName");
    // The commands still produced real output rather than silently printing nothing.
    expect(printed).toContain("key-id");
  });

  it("lists/gets metadata, updates metadata, previews/validates and deletes through the same API", async () => {
    reply = () => json([metadata]);
    await run("secret", "list", "--capability", "azure-ai-inference", "-o", "json");
    expect(requests[0].url).toContain("/keys?capability=azure-ai-inference");
    reply = () => json(metadata);
    await run("secret", "get", "key-id");
    await run("secret", "update", "key-id", "--disable", "--clear-expiry", "--comment", "");
    expect(JSON.parse(requests[2].body)).toEqual({ enabled: false, expiresAt: null, comment: null });
    reply = () => json({ status: "valid", capabilities: ["azure-ai-inference"] });
    await run("secret", "preview", "--type", "azure-ai-foundry", "--api-key", "fixture", "--endpoint", "https://resource.services.ai.azure.com/models");
    reply = () => json({ ...metadata, lastValidationStatus: "valid", capabilities: ["azure-ai-inference"] });
    await run("secret", "validate", "key-id");
    expect(vi.mocked(console.log).mock.calls.at(-1)?.[0]).toContain("valid");
    reply = () => new Response(null, { status: 204 });
    await run("secret", "delete", "key-id");
    expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "PUT", "POST", "POST", "DELETE"]);
    expect(requests.every((request) => request.token !== null)).toBe(true);
  });

  it("does not replay key registration after a transient server failure", async () => {
    reply = () => json({ error: "Registration unavailable" }, 503);

    await expect(run("secret", "create", "--type", "azure-ai-foundry", "--api-key", "fixture", "--endpoint", "https://resource.services.ai.azure.com/models")).rejects.toThrow("Registration unavailable");
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

    await expect(run("secret", "create", "--type", "azure-ai-foundry", "--api-key", "fixture", "--endpoint", "https://resource.services.ai.azure.com/models")).rejects.toThrow();
    expect(requests.map(request => request.method)).toEqual(["POST"]);
  });
});
