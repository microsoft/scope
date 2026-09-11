// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { accessSync, readFileSync, statSync } from "node:fs";
import { claudeCodeRuntime, detectClaudeCode, WORKER_TYPE } from "./runtime.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", () => ({
  accessSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
  constants: { X_OK: 1, R_OK: 4 },
}));
vi.mock("node:module", () => ({
  createRequire: () => ({ resolve: () => "/packages/claude-agent-acp/package.json" }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof statSync>);
  vi.mocked(execFileSync).mockReturnValueOnce("2.1.153 (Claude Code)\n").mockReturnValueOnce("--input-format --output-format --permission-mode stream-json");
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
    version: "0.52.0",
    bin: { "claude-agent-acp": "dist/index.js" },
    dependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.191" },
  }));
});

describe("installed Claude Code host runtime", () => {
  it("detects the CLI and uses the existing packaged ACP adapter", () => {
    const detected = detectClaudeCode({ SCOPE_HOST_EXECUTABLE: "/Applications/Claude Code/claude" });
    expect(detected).toMatchObject({
      workerType: WORKER_TYPE,
      executable: "/Applications/Claude Code/claude",
      adapter: "/packages/claude-agent-acp/dist/index.js",
      version: "2.1.153",
      agentVersion: "claude-code-2.1.153-acp-0.52.0",
      componentVersions: { CLAUDE_CODE_VERSION: "2.1.153", CLAUDE_CODE_ACP_VERSION: "0.52.0", CLAUDE_AGENT_SDK_VERSION: "0.3.191" },
    });
    expect(vi.mocked(execFileSync).mock.calls.map((call) => call[1])).toEqual([["--version"], ["--help"]]);
  });

  it("rejects a missing CLI without downloading a replacement", () => {
    vi.mocked(accessSync).mockImplementation(() => { throw new Error("ENOENT"); });
    expect(() => detectClaudeCode({ PATH: "/usr/bin" })).toThrow("Claude Code CLI not found");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("rejects unrelated executables and incompatible CLI capabilities", () => {
    vi.mocked(execFileSync).mockReset().mockReturnValueOnce("1.0.0").mockReturnValueOnce("--help");
    expect(() => detectClaudeCode({ SCOPE_HOST_EXECUTABLE: "/bin/claude" })).toThrow("must support stream-json");
  });

  it("points the adapter to the installed executable without modifying HOME or credentials", () => {
    const detected = detectClaudeCode({ CLAUDE_CODE_EXECUTABLE: "/bin/claude" });
    const runtime = claudeCodeRuntime(detected, { SCOPE_HOST_WORKSPACE_ROOT: "/data/claude", https_proxy: "http://company:8888", HOME: "/home/user" });
    expect(runtime).toMatchObject({
      workerName: WORKER_TYPE,
      command: process.execPath,
      args: ["/packages/claude-agent-acp/dist/index.js"],
      env: { CLAUDE_CODE_EXECUTABLE: "/bin/claude", DISABLE_AUTOUPDATER: "1" },
      hostLogin: true,
      captureProxy: false,
    });
    expect(Object.keys(runtime.env!)).toEqual(["CLAUDE_CODE_EXECUTABLE", "DISABLE_AUTOUPDATER"]);
  });

  it("requires an absolute dedicated workspace root", () => {
    const detected = detectClaudeCode({ SCOPE_HOST_EXECUTABLE: "/bin/claude" });
    expect(() => claudeCodeRuntime(detected, {})).toThrow("SCOPE_HOST_WORKSPACE_ROOT");
    expect(() => claudeCodeRuntime(detected, { SCOPE_HOST_WORKSPACE_ROOT: "." })).toThrow("absolute");
  });
});
