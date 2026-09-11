// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ClaudeCodeProcessor, startClaudeCodeWorker } from "./worker.js";
import { runACPSession } from "./acp-client.js";

const mocks = vi.hoisted(() => ({
  acquireTokenFull: vi.fn(),
  start: vi.fn(),
  queue: vi.fn(),
  proxyEnabled: vi.fn(),
  createProxy: vi.fn(),
  cleanupWorkspaces: vi.fn(),
}));
vi.mock("./acp-client.js", () => ({ runACPSession: vi.fn() }));
vi.mock("telemetry", () => ({ initTelemetry: vi.fn(), trackMetric: vi.fn(), trackTrace: vi.fn(), trackEvent: vi.fn() }));
vi.mock("shared", () => ({
  CodingAgentQueueProcessor: class {
    constructor(...args: unknown[]) { mocks.queue(...args); }
    start = mocks.start;
  },
  TokenManagerClient: class { acquireTokenFull = mocks.acquireTokenFull; },
  isProxyEnabled: mocks.proxyEnabled,
  createProxyClient: mocks.createProxy,
  KubedockClient: class { static isEnabled() { return false; } },
  McpGatewayClient: class { static isEnabled() { return false; } },
  createFreshWorkspace: vi.fn(),
  cleanupWorkspaces: mocks.cleanupWorkspaces,
}));

let workspaceRoot: string;
const log = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  vi.clearAllMocks();
  workspaceRoot = resolve("apps/workers/coder-acp-claude-code", `.test-workspaces-${randomUUID()}`);
  mocks.proxyEnabled.mockReturnValue(false);
  mocks.acquireTokenFull.mockResolvedValue({ value: "oauth-from-manager", keyType: "anthropic-oauth" });
  vi.mocked(runACPSession).mockResolvedValue({ response: "done", stopReason: "end_turn" });
});
afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("Claude Code shared host pipeline", () => {
  it("keeps the Docker adapter, token acquisition and proxy defaults unchanged", async () => {
    const processor = new ClaudeCodeProcessor();
    await processor.processMessage("task", log);
    expect(mocks.acquireTokenFull).toHaveBeenCalledWith("claude-code-cli", "anthropic-oauth");
    expect(runACPSession).toHaveBeenCalledWith("task", expect.objectContaining({
      command: "claude-agent-acp",
      args: [],
      env: expect.objectContaining({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-from-manager", HTTP_PROXY: "", NODE_EXTRA_CA_CERTS: "" }),
    }));
  });

  it("runs the packaged adapter against the installed CLI using existing login and proxy", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://company-proxy:8080");
    mocks.proxyEnabled.mockReturnValue(true);
    const processor = new ClaudeCodeProcessor({
      workerName: "coder-acp-claude-code-host",
      command: process.execPath,
      args: ["/packages/adapter/index.js"],
      env: { CLAUDE_CODE_EXECUTABLE: "/opt/claude" },
      hostLogin: true,
      captureProxy: false,
    });
    await processor.processMessage("task", log, { model: "claude-sonnet-4-6" });
    expect(mocks.acquireTokenFull).not.toHaveBeenCalled();
    expect(mocks.createProxy).not.toHaveBeenCalled();
    expect(runACPSession).toHaveBeenCalledWith("task", expect.objectContaining({
      command: process.execPath,
      args: ["/packages/adapter/index.js"],
      env: expect.objectContaining({ CLAUDE_CODE_EXECUTABLE: "/opt/claude", ANTHROPIC_MODEL: "claude-sonnet-4-6" }),
    }));
    const env = vi.mocked(runACPSession).mock.calls[0][1].env!;
    for (const key of ["HOME", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"]) {
      expect(env).not.toHaveProperty(key);
    }
    expect(process.env.HTTPS_PROXY).toBe("http://company-proxy:8080");
  });

  it("isolates concurrent host workspaces and removes only its run", async () => {
    const processor = new ClaudeCodeProcessor({ workspaceRoot, hostLogin: true });
    const sibling = resolve(workspaceRoot, "another-worker");
    mkdirSync(sibling, { recursive: true });
    await processor.setup(log);
    const workspace = processor.workspacePath!;
    expect(existsSync(workspace)).toBe(true);
    await processor.teardown(log);
    expect(existsSync(workspace)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
    expect(mocks.cleanupWorkspaces).not.toHaveBeenCalled();
  });

  it("uses its own ordinary queue and detected version", async () => {
    vi.stubEnv("QUEUE_NAME", "queue-coder-acp-claude-code");
    await startClaudeCodeWorker({ workerName: "coder-acp-claude-code-host", agentVersion: "claude-code-2.1.153-acp-0.52.0" });
    expect(mocks.queue).toHaveBeenCalledWith(expect.objectContaining({ queueName: "queue-coder-acp-claude-code-host" }), expect.any(ClaudeCodeProcessor));
    const processor: ClaudeCodeProcessor = mocks.queue.mock.calls[0][1];
    expect(processor.getAgentVersion()).toBe("claude-code-2.1.153-acp-0.52.0");
    expect(mocks.start).toHaveBeenCalledOnce();
  });
});
