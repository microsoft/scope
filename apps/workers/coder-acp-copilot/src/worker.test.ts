// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CopilotProcessor, startCopilotWorker } from "./worker.js";
import { runACPSession } from "./acp-client.js";

const mocks = vi.hoisted(() => ({
  acquireToken: vi.fn(),
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
  TokenManagerClient: class { acquireToken = mocks.acquireToken; },
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
  workspaceRoot = resolve("apps/workers/coder-acp-copilot", `.test-workspaces-${randomUUID()}`);
  mocks.proxyEnabled.mockReturnValue(false);
  mocks.acquireToken.mockResolvedValue("token-from-manager");
  vi.mocked(runACPSession).mockResolvedValue({ response: "done", stopReason: "end_turn" });
});
afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("Copilot shared host pipeline", () => {
  it("keeps Docker credentials, command and proxy defaults unchanged", async () => {
    const processor = new CopilotProcessor();
    await processor.processMessage("task", log);
    expect(mocks.acquireToken).toHaveBeenCalledWith("copilot-cli");
    expect(runACPSession).toHaveBeenCalledWith("task", expect.objectContaining({
      command: "copilot",
      args: ["--acp", "--yolo", "--no-auto-update"],
      authenticate: true,
      env: expect.objectContaining({ GITHUB_TOKEN: "token-from-manager", HTTP_PROXY: "", NODE_EXTRA_CA_CERTS: "" }),
    }));
  });

  it("runs the installed CLI without acquiring credentials or replacing inherited environment", async () => {
    vi.stubEnv("HTTP_PROXY", "http://company-proxy:8080");
    mocks.proxyEnabled.mockReturnValue(true);
    const processor = new CopilotProcessor({ workerName: "coder-acp-copilot-host", command: "/opt/copilot", hostLogin: true, captureProxy: false });
    await processor.processMessage("task", log, { model: "gpt-5.4" });
    expect(mocks.acquireToken).not.toHaveBeenCalled();
    expect(mocks.createProxy).not.toHaveBeenCalled();
    expect(runACPSession).toHaveBeenCalledWith("task", expect.objectContaining({
      command: "/opt/copilot",
      env: { COPILOT_AUTO_UPDATE: "false" },
      authenticate: false,
      model: "gpt-5.4",
    }));
    expect(process.env.HTTP_PROXY).toBe("http://company-proxy:8080");
  });

  it("isolates workspaces and only removes the completed run directory", async () => {
    const processor = new CopilotProcessor({ workspaceRoot, hostLogin: true });
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

  it("uses the ordinary host queue even when Docker queue env is inherited", async () => {
    vi.stubEnv("QUEUE_NAME", "queue-coder-acp-copilot");
    await startCopilotWorker({ workerName: "coder-acp-copilot-host", agentVersion: "copilot-0.0.451", componentVersions: { COPILOT_CLI_VERSION: "0.0.451" } });
    expect(mocks.queue).toHaveBeenCalledWith(expect.objectContaining({ queueName: "queue-coder-acp-copilot-host" }), expect.any(CopilotProcessor));
    const processor: CopilotProcessor = mocks.queue.mock.calls[0][1];
    expect(processor.getAgentVersion()).toBe("copilot-0.0.451");
    expect(processor.getComponentVersions()).toEqual({ COPILOT_CLI_VERSION: "0.0.451" });
    expect(mocks.start).toHaveBeenCalledOnce();
  });
});
