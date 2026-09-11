// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, parseScannerModels, registerAgent, registerModels } from "./api.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("ordinary agent/version registration", () => {
  it("retries transient API reads but not validation errors", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ healthy: true }));
    vi.stubGlobal("fetch", fetch);
    const result = apiRequest("http://localhost", "/health");
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toEqual({ healthy: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockReset().mockResolvedValue(new Response("invalid", { status: 400 }));
    await expect(apiRequest("http://localhost", "/bad")).rejects.toMatchObject({ status: 400 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("uses the existing API and retires previous versions independently for each worker type", async () => {
    const directory = resolve("apps/server/.test-state", randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/coder-acp-copilot.json`, JSON.stringify({
      _id: "coder-acp-copilot", name: "GitHub Copilot CLI", modelProvider: "github-copilot",
    }));
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: URL, options: RequestInit) => {
      calls.push({ path: url.pathname, method: options.method ?? "GET", body: options.body ? JSON.parse(String(options.body)) as unknown : undefined });
      return Response.json(options.method === "GET" ? [{ agentVersion: "copilot-old" }] : {});
    }));
    await registerAgent("http://localhost", directory, "coder-acp-copilot-host", {
      version: "0.1.0", digest: "a".repeat(64), versions: {},
    }, "copilot-1.0.65", { COPILOT_CLI_VERSION: "1.0.65" });
    expect(calls[0].body).toMatchObject({ _id: "coder-acp-copilot-host", available: false, modelProvider: "github-copilot" });
    expect(calls[2]).toMatchObject({
      path: "/api/v1/agents/coder-acp-copilot-host/versions/copilot-old",
      method: "PATCH", body: { status: "retired" },
    });
    expect(calls[3].body).toMatchObject({
      agentVersion: "copilot-1.0.65",
      queueName: "queue-coder-acp-copilot-host",
      components: { COPILOT_CLI_VERSION: "1.0.65" },
    });
  });

  it("registers the native catalog and default through existing model/agent routes", async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json({}));
    vi.stubGlobal("fetch", fetch);
    await registerModels("http://localhost", "coder-acp-copilot-host", {
      models: [{ id: "native-model", name: "Native model" }],
      defaultModel: "native-model",
    });
    expect(String(fetch.mock.calls[0][0])).toBe("http://localhost/api/v1/models/sync");
    expect(JSON.parse(fetch.mock.calls[0][1].body as string) as unknown).toMatchObject({
      agentId: "coder-acp-copilot-host", provider: "github-copilot",
      models: [{ id: "native-model", metadata: { name: "Native model" } }],
    });
    expect(JSON.parse(fetch.mock.calls[1][1].body as string) as unknown).toEqual({ defaultModel: "native-model" });
  });

  it("syncs a Docker scanner catalog only to its selected target, not other identities", async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json({}));
    vi.stubGlobal("fetch", fetch);
    const catalog = parseScannerModels('Scanning...\n--- Dry-run output ---\n{"models":[{"id":"advertised-model","capabilities":{"toolCalls":true}}]}');
    await registerModels("http://localhost", "coder-acp-copilot", catalog);
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0][1].body as string) as unknown).toMatchObject({
      agentId: "coder-acp-copilot", models: [{ id: "advertised-model", capabilities: { toolCalls: true } }],
    });
    expect(() => parseScannerModels("--- Dry-run output ---\n{\"models\":[]}")).toThrow("empty");
    expect(() => parseScannerModels("no output")).toThrow("did not return");
  });
});
