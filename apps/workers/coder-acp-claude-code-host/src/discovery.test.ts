// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { discoverACPModels } from "coder-acp-copilot/acp-client";
import { discoverClaudeCode } from "./discovery.js";

vi.mock("coder-acp-copilot/acp-client", () => ({ discoverACPModels: vi.fn() }));

const detected = {
  workerType: "coder-acp-claude-code-host",
  executable: "/installed/claude",
  adapter: "/packages/adapter/index.js",
  version: "2.1.193",
  agentVersion: "claude-code-2.1.193-acp-0.52.0",
  componentVersions: { CLAUDE_CODE_VERSION: "2.1.193", CLAUDE_CODE_ACP_VERSION: "0.52.0", CLAUDE_AGENT_SDK_VERSION: "0.3.191" },
};
let workspaceRoot: string;
beforeEach(() => {
  vi.resetAllMocks();
  workspaceRoot = resolve("apps/workers/coder-acp-claude-code-host", `.test-discovery-${randomUUID()}`);
});
afterEach(() => rmSync(workspaceRoot, { recursive: true, force: true }));

it("discovers through the packaged adapter with the installed CLI and existing login", async () => {
  const metadata = { supportedModels: ["actual"], models: [{ id: "actual", name: "Actual" }] };
  vi.mocked(discoverACPModels).mockResolvedValue(metadata);
  expect(await discoverClaudeCode(detected, { SCOPE_HOST_WORKSPACE_ROOT: workspaceRoot })).toEqual({ ...detected, ...metadata });
  expect(discoverACPModels).toHaveBeenCalledWith(expect.objectContaining({
    command: process.execPath,
    args: ["/packages/adapter/index.js"],
    env: { CLAUDE_CODE_EXECUTABLE: "/installed/claude", DISABLE_AUTOUPDATER: "1" },
  }));
  expect(existsSync(vi.mocked(discoverACPModels).mock.calls[0][0].cwd)).toBe(false);
});

it("fails discovery when native model metadata is unavailable and cleans its workspace", async () => {
  vi.mocked(discoverACPModels).mockRejectedValue(new Error("Native login required"));
  await expect(discoverClaudeCode(detected, { SCOPE_HOST_WORKSPACE_ROOT: workspaceRoot })).rejects.toThrow("Native login required");
  expect(existsSync(vi.mocked(discoverACPModels).mock.calls[0][0].cwd)).toBe(false);
});
