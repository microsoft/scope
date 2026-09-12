// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { accessSync, statSync } from "node:fs";
import { copilotRuntime, detectCopilot, WORKER_TYPE } from "./runtime.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", () => ({
  accessSync: vi.fn(),
  statSync: vi.fn(),
  constants: { X_OK: 1 },
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof statSync>);
  vi.mocked(execFileSync).mockReturnValueOnce("GitHub Copilot 0.0.451\n").mockReturnValueOnce("--acp --yolo --no-auto-update --disable-builtin-mcps --disable-mcp-server --additional-mcp-config");
});

describe("installed Copilot host runtime", () => {
  it("detects native ACP without installing, authenticating, or prompting", () => {
    const env = { SCOPE_HOST_EXECUTABLE: "/Applications/Copilot CLI/copilot", HOME: "/home/user", HTTPS_PROXY: "http://proxy:8080" };
    const detected = detectCopilot(env);
    expect(detected).toEqual({
      workerType: WORKER_TYPE,
      executable: env.SCOPE_HOST_EXECUTABLE,
      version: "0.0.451",
      agentVersion: "copilot-0.0.451",
      componentVersions: { COPILOT_CLI_VERSION: "0.0.451" },
    });
    expect(vi.mocked(execFileSync).mock.calls.map((call) => call[1])).toEqual([["--version"], ["--help"]]);
    expect(execFileSync).toHaveBeenCalledWith(env.SCOPE_HOST_EXECUTABLE, ["--help"], expect.objectContaining({
      timeout: 15_000,
      env: { ...env, COPILOT_AUTO_UPDATE: "false" },
    }));
  });

  it("searches PATH and rejects a missing CLI", () => {
    vi.mocked(accessSync).mockImplementation(() => { throw new Error("ENOENT"); });
    expect(() => detectCopilot({ PATH: "/usr/bin:/opt/bin" })).toThrow("Copilot CLI not found");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("rejects an old CLI without native ACP", () => {
    vi.mocked(execFileSync).mockReset().mockReturnValueOnce("0.0.100").mockReturnValueOnce("--help");
    expect(() => detectCopilot({ SCOPE_HOST_EXECUTABLE: "/bin/copilot" })).toThrow("must support native --acp");
  });

  it("uses a distinct worker identity and preserves host login/proxy settings", () => {
    const detected = detectCopilot({ SCOPE_HOST_EXECUTABLE: "/bin/copilot" });
    const runtime = copilotRuntime(detected, { SCOPE_HOST_WORKSPACE_ROOT: "/data/copilot", HTTP_PROXY: "http://company:8888" });
    expect(runtime).toMatchObject({ workerName: WORKER_TYPE, command: "/bin/copilot", hostLogin: true, isolateHostConfig: true, captureProxy: false, workspaceRoot: "/data/copilot" });
    expect(runtime).not.toHaveProperty("env");
    expect(copilotRuntime(detected, { SCOPE_HOST_WORKSPACE_ROOT: "/data/copilot" }).captureProxy).toBe(true);
  });

  it("requires a dedicated absolute workspace root", () => {
    const detected = detectCopilot({ SCOPE_HOST_EXECUTABLE: "/bin/copilot" });
    expect(() => copilotRuntime(detected, {})).toThrow("SCOPE_HOST_WORKSPACE_ROOT");
    expect(() => copilotRuntime(detected, { SCOPE_HOST_WORKSPACE_ROOT: "relative" })).toThrow("absolute");
  });
});
