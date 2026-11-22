// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerMcpCommands } from "./mcp.js";
import { resetApiClient } from "../utils/api-client.js";

const requests: Array<{ method: string; body: string }> = [];
const lines: string[] = [];

async function run(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerMcpCommands(program);
  await program.parseAsync(["mcp", "server", ...args, "--project", "project-1"], { from: "user" });
}

beforeEach(() => {
  resetApiClient();
  requests.length = 0;
  lines.length = 0;
  vi.stubEnv("SCOPE_API_URL", "http://localhost:3100");
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    requests.push({ method: request.method, body: await request.clone().text() });
    return new Response(JSON.stringify({ _id: "time", name: "Time", type: "stdio", command: "uvx", version: "1.2.3", createdAt: "2026-01-01T00:00:00Z" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }));
  vi.spyOn(console, "log").mockImplementation((...values) => lines.push(values.map(String).join(" ")));
});

afterEach(() => {
  resetApiClient();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("MCP package version CLI", () => {
  it("sends the version when creating a stdio server", async () => {
    await run("create", "--id", "time", "--name", "Time", "--type", "stdio", "--command", "uvx", "--args", "mcp-server-time", "--pkg-version", "1.2.3");
    expect(requests[0].method).toBe("POST");
    expect(JSON.parse(requests[0].body).version).toBe("1.2.3");
  });

  it("sends the version when updating a server", async () => {
    await run("update", "--id", "time", "--pkg-version", "1.2.3");
    expect(requests[0].method).toBe("PUT");
    expect(JSON.parse(requests[0].body)).toEqual({ version: "1.2.3" });
  });

  it("displays the stored version", async () => {
    await run("get", "--id", "time");
    expect(lines.join("\n")).toContain("1.2.3");
  });
});
