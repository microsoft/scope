// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { existsSync } from "node:fs";
import type { CopilotClientOptions, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposedPromptRequest } from "../adapter/protocol.js";
import { createLocalCopilotContext, denyLocalPermission, localClientOptions, localSessionConfig } from "./local-copilot.js";

interface Harness {
  clients: CopilotClientOptions[];
  sessions: SessionConfig[];
  deleted: string[];
  stops: number;
  forceStops: number;
  aborts: number;
  fail: boolean;
  failConstructor: boolean;
  cleanupErrors: Error[];
  turns: number;
  exposedTools: string[];
}

const harness = vi.hoisted<Harness>(() => ({
  clients: [], sessions: [], deleted: [], stops: 0, forceStops: 0, aborts: 0,
  fail: false, failConstructor: false, cleanupErrors: [], turns: 1, exposedTools: ["contribution_report"],
}));

vi.mock("@github/copilot-sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@github/copilot-sdk")>();
  return {
    ...sdk,
    CopilotClient: class {
      constructor(options: CopilotClientOptions) {
        harness.clients.push(options);
        if (harness.failConstructor) throw new Error("Runtime initialization failed");
      }
      async start() {}
      async getStatus() { return { version: "test-runtime" }; }
      async createSession(config: SessionConfig) {
        harness.sessions.push(config);
        let eventHandler: ((event: SessionEvent) => void) | undefined;
        return {
          sessionId: "local-test-session",
          rpc: { tools: {
            async initializeAndValidate() {},
            async getCurrentMetadata() { return { tools: harness.exposedTools.map((name) => ({ name })) }; },
          } },
          on(handler: (event: SessionEvent) => void) {
            eventHandler = handler;
            return () => { eventHandler = undefined; };
          },
          async abort() { harness.aborts += 1; },
          async sendAndWait() {
            if (harness.fail) throw new Error("Inference failed");
            for (let index = 0; index < harness.turns; index += 1) {
              const event: SessionEvent = JSON.parse(JSON.stringify({
                type: "assistant.turn_start", id: String(index), parentId: null,
                timestamp: "2026-10-20T19:30:00Z", data: { turnId: String(index) },
              }));
              eventHandler?.(event);
            }
            const tool = config.tools?.[0];
            if (!tool?.handler) throw new Error("Missing report tool");
            await tool.handler({ report: '{"schemaVersion":2,"assessments":[]}' }, {
              sessionId: "local-test-session", toolCallId: "report", toolName: "contribution_report", arguments: {},
            });
          },
        };
      }
      async deleteSession(id: string) { harness.deleted.push(id); }
      async stop() { harness.stops += 1; return harness.cleanupErrors; }
      async forceStop() { harness.forceStops += 1; }
    },
  };
});

beforeEach(() => {
  Object.assign(harness, {
    clients: [], sessions: [], deleted: [], stops: 0, forceStops: 0, aborts: 0,
    fail: false, failConstructor: false, cleanupErrors: [], turns: 1, exposedTools: ["contribution_report"],
  });
});

const request: ComposedPromptRequest = {
  messages: [{ role: "system", content: "Owned workflow instructions." }, { role: "user", content: "Captured untrusted data." }],
  tools: [{ name: "contribution_report", description: "Report-only output", parameters: { type: "object" } }],
  metadata: { adapterId: "contribution-insights/default", productionSources: [], fidelity: "partial" },
};

describe("local Copilot isolation", () => {
  it("uses an empty one-shot runtime with sanitized environment and no ambient authentication", () => {
    const options = localClientOptions("test-token", "/isolated/runtime", "/bin/copilot", {
      PATH: "/bin", HOME: "/original", GH_TOKEN: "not-inherited", OPENAI_API_KEY: "not-inherited",
      CONTRIBUTION_DECISION_API_KEY: "not-inherited", CONTRIBUTION_DECISION_ENTRA_TOKEN: "not-inherited",
      COPILOT_ALLOW_ALL: "true", NODE_OPTIONS: "--require=untrusted",
    });
    expect(options).toMatchObject({
      mode: "empty", baseDirectory: "/isolated/runtime/state", workingDirectory: "/isolated/runtime",
      gitHubToken: "test-token", useLoggedInUser: false,
      env: { PATH: "/bin", HOME: "/isolated/runtime" },
    });
    for (const key of ["GH_TOKEN", "OPENAI_API_KEY", "CONTRIBUTION_DECISION_API_KEY", "CONTRIBUTION_DECISION_ENTRA_TOKEN", "COPILOT_ALLOW_ALL", "NODE_OPTIONS"]) {
      expect(options.env).not.toHaveProperty(key);
    }
    expect(options.connection).toMatchObject({
      kind: "stdio", path: "/bin/copilot", args: ["--disable-builtin-mcps", "--max-ai-credits", "200"],
    });
  });

  it("exposes only the custom report tool and disables every ambient execution surface", () => {
    const config = localSessionConfig("auto", "Owned instructions", []);
    expect(config).toMatchObject({
      availableTools: ["custom:contribution_report"], excludedTools: ["builtin:*", "mcp:*"],
      enableSkills: false, enableFileHooks: false, enableHostGitOperations: false,
      enableSessionStore: false, enableConfigDiscovery: false, skipCustomInstructions: true,
      requestExtensions: false, requestCanvasRenderer: false, remoteSession: "off",
      mcpServers: {}, customAgents: [], pluginDirectories: [], skillDirectories: [],
      infiniteSessions: { enabled: false },
    });
    expect(denyLocalPermission()).toEqual({ kind: "reject" });
  });

  it("uses the actual report callback and removes session data and its runtime directory", async () => {
    const executeTool = vi.fn(async () => ({ submitted: true }));
    const result = await createLocalCopilotContext({
      token: "test-token", cliPath: "/bin/copilot", model: "auto", timeoutMs: 30_000,
    }).complete(request, { executeTool });
    expect(result.content).toBe('{"schemaVersion":2,"assessments":[]}');
    expect(executeTool).toHaveBeenCalledWith("contribution_report", { report: result.content });
    expect(harness.deleted).toEqual(["local-test-session"]);
    expect(harness.stops).toBe(1);
    expect(existsSync(harness.clients[0].workingDirectory!)).toBe(false);
    expect(result.metadata).toMatchObject({ source: "local-copilot-sdk", fidelity: "partial", turns: 1 });
  });

  it("cleans up and surfaces inference errors without silently retrying paid calls", async () => {
    harness.fail = true;
    await expect(createLocalCopilotContext({
      token: "test-token", cliPath: "/bin/copilot", model: "auto", timeoutMs: 30_000,
    }).complete(request, { executeTool: async () => ({}) })).rejects.toThrow("Inference failed");
    expect(harness.clients).toHaveLength(1);
    expect(harness.deleted).toEqual(["local-test-session"]);
    expect(harness.stops).toBe(1);
    expect(existsSync(harness.clients[0].workingDirectory!)).toBe(false);
  });

  it("checks the actual runtime tool graph before making an inference call", async () => {
    harness.exposedTools = ["contribution_report", "shell"];
    await expect(createLocalCopilotContext({
      token: "test-token", cliPath: "/bin/copilot", model: "auto", timeoutMs: 30_000,
    }).complete(request, { executeTool: async () => ({}) })).rejects.toThrow("exactly the report-only tool");
    expect(harness.deleted).toEqual(["local-test-session"]);
    expect(harness.stops).toBe(1);
  });

  it("removes the isolated directory even when runtime construction fails", async () => {
    harness.failConstructor = true;
    await expect(createLocalCopilotContext({
      token: "test-token", cliPath: "/bin/copilot", model: "auto", timeoutMs: 30_000,
    }).complete(request, { executeTool: async () => ({}) })).rejects.toThrow("Runtime initialization failed");
    expect(existsSync(harness.clients[0].workingDirectory!)).toBe(false);
    expect(harness.stops).toBe(0);
  });

  it("aborts excessive model turns and reports cleanup failures explicitly", async () => {
    harness.turns = 21;
    await expect(createLocalCopilotContext({
      token: "test-token", cliPath: "/bin/copilot", model: "auto", timeoutMs: 30_000,
    }).complete(request, { executeTool: async () => ({}) })).rejects.toThrow("exceeded 20");
    expect(harness.aborts).toBe(1);
    harness.turns = 1;
    harness.cleanupErrors = [new Error("Cleanup failed")];
    await expect(createLocalCopilotContext({
      token: "test-token", cliPath: "/bin/copilot", model: "auto", timeoutMs: 30_000,
    }).complete(request, { executeTool: async () => ({}) })).rejects.toThrow("Cleanup failed");
    expect(harness.forceStops).toBe(1);
  });
});
