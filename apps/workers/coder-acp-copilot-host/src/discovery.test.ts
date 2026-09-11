// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { discoverACPModels } from "coder-acp-copilot/acp-client";
import { discoverCopilot } from "./discovery.js";

vi.mock("coder-acp-copilot/acp-client", () => ({ discoverACPModels: vi.fn() }));

const detected = {
  workerType: "coder-acp-copilot-host",
  executable: "/installed/copilot",
  version: "1.0.0",
  agentVersion: "copilot-1.0.0",
  componentVersions: { COPILOT_CLI_VERSION: "1.0.0" },
};
let workspaceRoot: string;
beforeEach(() => {
  vi.resetAllMocks();
  workspaceRoot = resolve("apps/workers/coder-acp-copilot-host", `.test-discovery-${randomUUID()}`);
});
afterEach(() => rmSync(workspaceRoot, { recursive: true, force: true }));

it("returns native metadata and removes its discovery workspace", async () => {
  const metadata = { supportedModels: ["actual"], models: [{ id: "actual", name: "Actual" }], defaultModel: "actual" };
  vi.mocked(discoverACPModels).mockResolvedValue(metadata);
  expect(await discoverCopilot(detected, { SCOPE_HOST_WORKSPACE_ROOT: workspaceRoot })).toEqual({ ...detected, ...metadata });
  expect(discoverACPModels).toHaveBeenCalledWith(expect.objectContaining({
    command: "/installed/copilot",
    args: ["--acp", "--no-auto-update"],
    env: { COPILOT_AUTO_UPDATE: "false" },
  }));
  expect(existsSync(vi.mocked(discoverACPModels).mock.calls[0][0].cwd)).toBe(false);
});

it("surfaces unavailable native metadata rather than registering fallback models", async () => {
  vi.mocked(discoverACPModels).mockRejectedValue(new Error("Native login required"));
  await expect(discoverCopilot(detected, { SCOPE_HOST_WORKSPACE_ROOT: workspaceRoot })).rejects.toThrow("Native login required");
  expect(existsSync(vi.mocked(discoverACPModels).mock.calls[0][0].cwd)).toBe(false);
});
