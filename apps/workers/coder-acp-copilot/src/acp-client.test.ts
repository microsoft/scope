// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import { runACPSession, discoverACPModels, extractModelDiscovery, selectModel, selectReasoningEffort, selectPermissionMode, formatModeError, formatToolArgs, formatToolContent, AUTOPILOT_MODE_ID } from "./acp-client.js";
import type * as acp from "@agentclientprotocol/sdk";
import os from "node:os";

describe("formatToolContent", () => {
  it("returns an empty string for non-array or empty input", () => {
    expect(formatToolContent(undefined)).toBe("");
    expect(formatToolContent([])).toBe("");
  });

  it("formats a diff variant as `diff <path> <newText>`", () => {
    expect(
      formatToolContent([
        { type: "diff", path: "/tmp/app.js", newText: "const x = 1", oldText: null },
      ])
    ).toBe("diff /tmp/app.js const x = 1");
  });

  it("redacts diff text for sensitive file paths", () => {
    expect(
      formatToolContent([
        { type: "diff", path: "/app/.env", newText: "API_KEY=sk-123", oldText: null },
      ])
    ).toBe("diff /app/.env [redacted]");
  });

  it("formats a terminal variant as `terminal <terminalId>`", () => {
    expect(
      formatToolContent([{ type: "terminal", terminalId: "term-123" }])
    ).toBe("terminal term-123");
  });

  it("formats a text content block as its text and others as a bracketed type", () => {
    expect(
      formatToolContent([
        { type: "content", content: { type: "text", text: "hello world" } },
      ])
    ).toBe("hello world");
    expect(
      formatToolContent([
        { type: "content", content: { type: "image", data: "..." } },
      ])
    ).toBe("[image]");
  });

  it("truncates long previews with an ellipsis", () => {
    const result = formatToolContent(
      [{ type: "diff", path: "f", newText: "a".repeat(300) }],
      20
    );
    expect(result.length).toBe(20);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("formatToolArgs", () => {
  it("returns an empty string for non-object input", () => {
    expect(formatToolArgs(undefined)).toBe("");
    expect(formatToolArgs(null)).toBe("");
    expect(formatToolArgs("hello")).toBe("");
    expect(formatToolArgs(42)).toBe("");
  });

  it("returns an empty string for an empty object", () => {
    expect(formatToolArgs({})).toBe("");
  });

  it("formats string arguments as key=value pairs", () => {
    expect(formatToolArgs({ command: "ls -la", cwd: "/tmp" })).toBe(
      "command=ls -la, cwd=/tmp"
    );
  });

  it("collapses whitespace in values", () => {
    expect(formatToolArgs({ content: "line1\n  line2\t line3" })).toBe(
      "content=line1 line2 line3"
    );
  });

  it("JSON-stringifies non-string values", () => {
    expect(formatToolArgs({ count: 3, flag: true })).toBe(
      "count=3, flag=true"
    );
  });

  it("truncates long previews with an ellipsis", () => {
    const result = formatToolArgs({ path: "a".repeat(300) }, 20);
    expect(result.length).toBe(20);
    expect(result.endsWith("…")).toBe(true);
  });

  it("redacts values of sensitive keys", () => {
    expect(
      formatToolArgs({
        url: "https://api.example.com",
        token: "sk-secret-123",
        AUTHORIZATION: "Bearer abc",
        api_key: "xyz",
        password: "hunter2",
      })
    ).toBe(
      "url=https://api.example.com, token=[redacted], AUTHORIZATION=[redacted], api_key=[redacted], password=[redacted]"
    );
  });
});

describe("runACPSession", () => {
  const cwd = os.tmpdir();
  const noop = () => {};

  describe("subprocess early exit", () => {
    it("rejects when the agent process exits immediately with non-zero code", async () => {
      // Use a command that exits immediately with code 1
      await expect(
        runACPSession("hello", {
          command: "node",
          args: ["-e", "process.exit(1)"],
          cwd,
          onLog: noop,
          sessionTimeoutMs: 5000,
        })
      ).rejects.toThrow(/ACP agent process exited unexpectedly \(code 1\)/);
    });

    it("rejects when the agent process prints to stderr and exits", async () => {
      await expect(
        runACPSession("hello", {
          command: "node",
          args: ["-e", 'console.error("Node.js v24 required"); process.exit(1)'],
          cwd,
          onLog: noop,
          sessionTimeoutMs: 5000,
        })
      ).rejects.toThrow(/ACP agent process exited unexpectedly/);
    });

    it("rejects when the command is not found", async () => {
      await expect(
        runACPSession("hello", {
          command: "nonexistent-binary-that-does-not-exist",
          args: [],
          cwd,
          onLog: noop,
          sessionTimeoutMs: 5000,
        })
      ).rejects.toThrow(/ACP agent process failed to start/);
    });
  });

  describe("session timeout", () => {
    it("rejects after the configured timeout", async () => {
      // Use a command that hangs (cat with no input on stdin will block)
      await expect(
        runACPSession("hello", {
          command: "node",
          args: ["-e", "setTimeout(() => {}, 60000)"],
          cwd,
          onLog: noop,
          sessionTimeoutMs: 200,
        })
      ).rejects.toThrow(/ACP session timed out after 200ms/);
    });
  });

  it.each([
    { authenticate: undefined, expected: "authenticated" },
    { authenticate: false, expected: "host-login" },
  ])("preserves the $expected authentication path over ACP", async ({ authenticate, expected }) => {
    const fakeAgent = `
      let authenticated = false;
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        let result = {};
        if (request.method === "initialize") {
          result = { protocolVersion: request.params.protocolVersion, agentCapabilities: {},
            authMethods: [{ id: "login", name: "Existing login" }] };
        } else if (request.method === "authenticate") {
          authenticated = true;
        } else if (request.method === "session/new") {
          result = { sessionId: "test-session" };
        } else if (request.method === "session/prompt") {
          send({ jsonrpc: "2.0", method: "session/update", params: {
            sessionId: "test-session", update: { sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: authenticated ? "authenticated" : "host-login" } }
          } });
          result = { stopReason: "end_turn" };
        }
        send({ jsonrpc: "2.0", id: request.id, result });
      });
    `;
    const result = await runACPSession("test input", {
      command: process.execPath,
      args: ["-e", fakeAgent],
      cwd,
      onLog: noop,
      authenticate,
      sessionTimeoutMs: 5_000,
    });
    expect(result.response).toBe(expected);
    expect(result.stopReason).toBe("end_turn");
  });
});

describe("native ACP model discovery", () => {
  it("reads advertised models without authentication, permission changes or a prompt", async () => {
    const fakeAgent = `
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        let result;
        if (request.method === "initialize") {
          result = { protocolVersion: request.params.protocolVersion, agentCapabilities: {},
            authMethods: [{ id: "login", name: "Existing login" }] };
        } else if (request.method === "session/new") {
          result = { sessionId: "discovery-session", models: {
            currentModelId: "native-model", availableModels: [{ modelId: "native-model", name: "Native Model" }]
          } };
        } else {
          send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Discovery must not invoke " + request.method } });
          return;
        }
        send({ jsonrpc: "2.0", id: request.id, result });
      });
    `;
    expect(await discoverACPModels({
      command: process.execPath,
      args: ["-e", fakeAgent],
      cwd: process.cwd(),
      onLog: () => {},
      sessionTimeoutMs: 5_000,
    })).toEqual({
      supportedModels: ["native-model"],
      models: [{ id: "native-model", name: "Native Model" }],
      defaultModel: "native-model",
    });
  });

  it("reads native model config options, including grouped options", () => {
    expect(extractModelDiscovery({
      sessionId: "session",
      models: { currentModelId: "unknown", availableModels: [] },
      configOptions: [{
        id: "model",
        category: "model",
        name: "Model",
        type: "select",
        currentValue: "advertised-model",
        options: [{ group: "provider", name: "Provider", options: [{ value: "advertised-model", name: "Advertised model" }] }],
      }],
    })).toEqual({
      supportedModels: ["advertised-model"],
      models: [{ id: "advertised-model", name: "Advertised model" }],
      defaultModel: "advertised-model",
    });
  });

  it("does not invent models or a default when metadata is unavailable", () => {
    expect(() => extractModelDiscovery({ sessionId: "session" })).toThrow("did not advertise any models");
    expect(extractModelDiscovery({
      sessionId: "session",
      models: { currentModelId: "unknown", availableModels: [{ modelId: "actual", name: "Actual" }] },
    })).not.toHaveProperty("defaultModel");
  });
});

describe("selectModel", () => {
  function makeConnection(overrides?: Partial<acp.ClientSideConnection>): acp.ClientSideConnection {
    return {
      unstable_setSessionModel: vi.fn().mockResolvedValue({}),
      setSessionConfigOption: vi.fn().mockResolvedValue({ configOptions: [] }),
      ...overrides,
    } as unknown as acp.ClientSideConnection;
  }

  function makeSession(overrides?: Partial<acp.NewSessionResponse>): acp.NewSessionResponse {
    return {
      sessionId: "session-1",
      ...overrides,
    } as acp.NewSessionResponse;
  }

  it("calls unstable_setSessionModel when models field is present", async () => {
    const connection = makeConnection();
    const session = makeSession({
      models: {
        currentModelId: "claude-sonnet-4.6",
        availableModels: [
          { modelId: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
          { modelId: "gpt-5.4", name: "GPT 5.4" },
        ],
      },
    });
    const logs: string[] = [];

    await selectModel(connection, session, "gpt-5.4", (msg) => logs.push(msg));

    expect(connection.unstable_setSessionModel).toHaveBeenCalledWith({
      sessionId: "session-1",
      modelId: "gpt-5.4",
    });
    expect(connection.setSessionConfigOption).not.toHaveBeenCalled();
    expect(logs).toContain('Model set to "gpt-5.4" via session/set_model');
  });

  it("returns the model string on success", async () => {
    const connection = makeConnection();
    const session = makeSession({
      models: {
        currentModelId: "claude-sonnet-4.6",
        availableModels: [{ modelId: "gpt-5.4", name: "GPT 5.4" }],
      },
    });

    const result = await selectModel(connection, session, "gpt-5.4", () => {});

    expect(result).toBe("gpt-5.4");
  });

  it("logs a warning when the requested model is not in availableModels but still calls set_model", async () => {
    const connection = makeConnection();
    const session = makeSession({
      models: {
        currentModelId: "claude-sonnet-4.6",
        availableModels: [{ modelId: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" }],
      },
    });
    const logs: string[] = [];

    await selectModel(connection, session, "gpt-5.4", (msg) => logs.push(msg));

    expect(connection.unstable_setSessionModel).toHaveBeenCalledWith({
      sessionId: "session-1",
      modelId: "gpt-5.4",
    });
    expect(logs.some((l) => l.includes('not in available models'))).toBe(true);
  });

  it("uses setSessionConfigOption when a model config option is present and models field is absent", async () => {
    const connection = makeConnection();
    const session = makeSession({
      configOptions: [
        { id: "model-picker", category: "model", name: "Model", currentValue: "claude-sonnet-4.6", options: [], type: "select" },
      ],
    });
    const logs: string[] = [];

    await selectModel(connection, session, "gpt-5.4", (msg) => logs.push(msg));

    expect(connection.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      configId: "model-picker",
      value: "gpt-5.4",
    });
    expect(connection.unstable_setSessionModel).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('via session/set_config_option'))).toBe(true);
  });

  it("logs a warning and does nothing when neither models nor model config option is present", async () => {
    const connection = makeConnection();
    const session = makeSession({ configOptions: [] });
    const logs: string[] = [];

    await selectModel(connection, session, "gpt-5.4", (msg) => logs.push(msg));

    expect(connection.unstable_setSessionModel).not.toHaveBeenCalled();
    expect(connection.setSessionConfigOption).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('does not advertise model selection capability'))).toBe(true);
  });

  it("logs a warning and continues when unstable_setSessionModel throws", async () => {
    const connection = makeConnection({
      unstable_setSessionModel: vi.fn().mockRejectedValue(new Error("not supported")),
    });
    const session = makeSession({
      models: {
        currentModelId: "claude-sonnet-4.6",
        availableModels: [{ modelId: "gpt-5.4", name: "GPT 5.4" }],
      },
    });
    const logs: string[] = [];

    await expect(selectModel(connection, session, "gpt-5.4", (msg) => logs.push(msg))).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes('session/set_model failed'))).toBe(true);
  });
});

describe("selectReasoningEffort", () => {
  function makeConnection(overrides?: Partial<acp.ClientSideConnection>): acp.ClientSideConnection {
    return {
      setSessionConfigOption: vi.fn().mockResolvedValue({ configOptions: [] }),
      ...overrides,
    } as unknown as acp.ClientSideConnection;
  }

  function makeSession(overrides?: Partial<acp.NewSessionResponse>): acp.NewSessionResponse {
    return {
      sessionId: "session-1",
      ...overrides,
    } as acp.NewSessionResponse;
  }

  it("sets effort via setSessionConfigOption when thought_level config option exists", async () => {
    const connection = makeConnection();
    const session = makeSession({
      configOptions: [
        { id: "reasoning_effort", category: "thought_level", name: "Reasoning Effort", currentValue: "medium", options: [], type: "select" },
      ],
    });
    const logs: string[] = [];

    const result = await selectReasoningEffort(connection, session, "high", (msg) => logs.push(msg));

    expect(connection.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      configId: "reasoning_effort",
      value: "high",
    });
    expect(result).toBe("high");
    expect(logs).toContain('Reasoning effort set to "high" via session/set_config_option (configId: reasoning_effort)');
  });

  it("warns when configOptions is undefined", async () => {
    const connection = makeConnection();
    const session = makeSession({ configOptions: undefined });
    const logs: string[] = [];

    const result = await selectReasoningEffort(connection, session, "low", (msg) => logs.push(msg));

    expect(connection.setSessionConfigOption).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
    expect(logs.some((l) => l.includes("does not advertise config options"))).toBe(true);
  });

  it("warns when no thought_level config option exists", async () => {
    const connection = makeConnection();
    const session = makeSession({
      configOptions: [
        { id: "model-picker", category: "model", name: "Model", currentValue: "gpt-4o", options: [], type: "select" },
      ],
    });
    const logs: string[] = [];

    const result = await selectReasoningEffort(connection, session, "high", (msg) => logs.push(msg));

    expect(connection.setSessionConfigOption).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
    expect(logs.some((l) => l.includes('does not advertise a "thought_level" config option'))).toBe(true);
  });

  it("warns and returns undefined when setSessionConfigOption throws", async () => {
    const connection = makeConnection({
      setSessionConfigOption: vi.fn().mockRejectedValue(new Error("config not writable")),
    });
    const session = makeSession({
      configOptions: [
        { id: "reasoning_effort", category: "thought_level", name: "Reasoning Effort", currentValue: "medium", options: [], type: "select" },
      ],
    });
    const logs: string[] = [];

    const result = await selectReasoningEffort(connection, session, "high", (msg) => logs.push(msg));

    expect(result).toBeUndefined();
    expect(logs.some((l) => l.includes("session/set_config_option failed"))).toBe(true);
  });
});

describe("selectPermissionMode", () => {
  function makeConnection(overrides?: Partial<acp.ClientSideConnection>): acp.ClientSideConnection {
    return {
      setSessionMode: vi.fn().mockResolvedValue({}),
      ...overrides,
    } as unknown as acp.ClientSideConnection;
  }

  function makeSession(overrides?: Partial<acp.NewSessionResponse>): acp.NewSessionResponse {
    return {
      sessionId: "session-1",
      ...overrides,
    } as acp.NewSessionResponse;
  }

  const modesWithAutopilot = {
    currentModeId: "https://agentclientprotocol.com/protocol/session-modes#agent",
    availableModes: [
      { id: "https://agentclientprotocol.com/protocol/session-modes#agent", name: "Agent" },
      { id: "https://agentclientprotocol.com/protocol/session-modes#plan", name: "Plan" },
      { id: AUTOPILOT_MODE_ID, name: "Autopilot" },
    ],
  };

  it("sets autopilot mode by its canonical URL id", async () => {
    const connection = makeConnection();
    const session = makeSession({ modes: modesWithAutopilot } as Partial<acp.NewSessionResponse>);
    const logs: string[] = [];

    await selectPermissionMode(connection, session, (msg) => logs.push(msg));

    expect(connection.setSessionMode).toHaveBeenCalledWith({
      sessionId: "session-1",
      modeId: AUTOPILOT_MODE_ID,
    });
    expect(logs.some((l) => l.includes("Set session mode to autopilot"))).toBe(true);
  });

  it("matches a bare '#autopilot' id via the endsWith safety net", async () => {
    const connection = makeConnection();
    const session = makeSession({
      modes: {
        currentModeId: "agent",
        availableModes: [
          { id: "agent", name: "Agent" },
          { id: "x#autopilot", name: "Autopilot" },
        ],
      },
    } as Partial<acp.NewSessionResponse>);
    const logs: string[] = [];

    await selectPermissionMode(connection, session, (msg) => logs.push(msg));

    expect(connection.setSessionMode).toHaveBeenCalledWith({
      sessionId: "session-1",
      modeId: "x#autopilot",
    });
  });

  it("warns and no-ops when no autopilot mode is advertised", async () => {
    const connection = makeConnection();
    const session = makeSession({
      modes: {
        currentModeId: "https://agentclientprotocol.com/protocol/session-modes#agent",
        availableModes: [
          { id: "https://agentclientprotocol.com/protocol/session-modes#agent", name: "Agent" },
          { id: "https://agentclientprotocol.com/protocol/session-modes#plan", name: "Plan" },
        ],
      },
    } as Partial<acp.NewSessionResponse>);
    const logs: string[] = [];

    await selectPermissionMode(connection, session, (msg) => logs.push(msg));

    expect(connection.setSessionMode).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("autopilot mode not available"))).toBe(true);
  });

  it("warns and no-ops when no modes field is present", async () => {
    const connection = makeConnection();
    const session = makeSession();
    const logs: string[] = [];

    await selectPermissionMode(connection, session, (msg) => logs.push(msg));

    expect(connection.setSessionMode).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("autopilot mode not available"))).toBe(true);
  });

  it("warns and continues when setSessionMode throws on every attempt", async () => {
    const connection = makeConnection({
      setSessionMode: vi.fn().mockRejectedValue(new Error("mode not writable")),
    });
    const session = makeSession({ modes: modesWithAutopilot } as Partial<acp.NewSessionResponse>);
    const logs: string[] = [];

    await selectPermissionMode(connection, session, (msg) => logs.push(msg));

    expect(connection.setSessionMode).toHaveBeenCalledTimes(2);
    expect(logs.some((l) => l.includes("failed to set autopilot session mode after 2 attempts"))).toBe(true);
  });

  it("retries once and succeeds when the first set_mode call fails (cold start)", async () => {
    const setSessionMode = vi
      .fn()
      .mockRejectedValueOnce({ code: -32000, message: "session not ready" })
      .mockResolvedValueOnce({});
    const connection = makeConnection({ setSessionMode });
    const session = makeSession({ modes: modesWithAutopilot } as Partial<acp.NewSessionResponse>);
    const logs: string[] = [];

    await selectPermissionMode(connection, session, (msg) => logs.push(msg));

    expect(setSessionMode).toHaveBeenCalledTimes(2);
    expect(logs.some((l) => l.includes("retrying"))).toBe(true);
    expect(logs.some((l) => l.includes("Set session mode to autopilot"))).toBe(true);
  });

  it("serializes a non-Error JSON-RPC rejection instead of logging [object Object]", async () => {
    const connection = makeConnection({
      setSessionMode: vi.fn().mockRejectedValue({ code: -32601, message: "method not found" }),
    });
    const session = makeSession({ modes: modesWithAutopilot } as Partial<acp.NewSessionResponse>);
    const logs: string[] = [];

    await selectPermissionMode(connection, session, (msg) => logs.push(msg));

    expect(logs.some((l) => l.includes("[object Object]"))).toBe(false);
    expect(logs.some((l) => l.includes("method not found") && l.includes("code -32601"))).toBe(true);
  });
});

describe("formatModeError", () => {
  it("uses the message of an Error instance", () => {
    expect(formatModeError(new Error("boom"))).toBe("boom");
  });

  it("uses message and code for JSON-RPC-style objects", () => {
    expect(formatModeError({ code: -32000, message: "not ready" })).toBe("not ready (code -32000)");
  });

  it("JSON-stringifies objects without a message", () => {
    expect(formatModeError({ foo: "bar" })).toBe('{"foo":"bar"}');
  });

  it("falls back to String for primitives", () => {
    expect(formatModeError("plain string")).toBe("plain string");
  });
});
