// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  clientOptions: [] as Array<{
    env?: Record<string, string | undefined>;
    [key: string]: unknown;
  }>,
  start: vi.fn(async () => undefined),
  getAuthStatus: vi.fn(async () => ({ isAuthenticated: true })),
  stop: vi.fn(async () => undefined),
  sessionOptions: [] as Array<Record<string, unknown>>,
  deleteSession: vi.fn(async () => undefined),
}));

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: class {
    start = sdkMocks.start;
    getAuthStatus = sdkMocks.getAuthStatus;
    stop = sdkMocks.stop;
    deleteSession = sdkMocks.deleteSession;
    createSession = vi.fn(async (options: Record<string, unknown>) => {
      sdkMocks.sessionOptions.push(options);
      return {
        sessionId: "auth-test-session",
        on: vi.fn(() => () => { }),
        sendAndWait: vi.fn(async () => ({ data: { content: "ok" } })),
        abort: vi.fn(async () => { }),
        disconnect: vi.fn(async () => { }),
      };
    });

    constructor(options: {
      env?: Record<string, string | undefined>;
      [key: string]: unknown;
    }) {
      sdkMocks.clientOptions.push(options);
    }
  },
}));

import {
  closeTransports,
  copilotAI,
  openCopilotTransport,
  resolveCopilotCredential,
  taxonomyPromptExecutor,
} from "./copilot.js";
import { evaluate } from "./engine.js";
import { createHandlerRegistry } from "./handlers.js";
import { parseScopeAtif } from "./scope-atif.js";
import { loadTaxonomy } from "./taxonomy.js";
import { executeSdkCall } from "./sdk-call.js";

beforeEach(() => {
  vi.clearAllMocks();
  sdkMocks.clientOptions.length = 0;
  sdkMocks.sessionOptions.length = 0;
  sdkMocks.start.mockResolvedValue(undefined);
  sdkMocks.getAuthStatus.mockResolvedValue({ isAuthenticated: true });
  sdkMocks.stop.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** @returns Observable SDK session mocks for lifecycle failure tests. */
function fixture() {
  const session: Pick<CopilotSession, "on" | "sendAndWait" | "abort" | "disconnect" | "sessionId"> = {
    sessionId: "mock",
    on: vi.fn(() => () => { }),
    sendAndWait: vi.fn(async () => undefined),
    abort: vi.fn(async () => { }),
    disconnect: vi.fn(async () => { }),
  };
  const deleted = vi.fn(async () => { });
  return { session, deleted };
}

describe("Copilot SDK authentication boundary (offline)", () => {
  it("prefers supported environment tokens without invoking GitHub CLI", async () => {
    const readGhToken = vi.fn(async () => "unused-gh-token");

    await expect(resolveCopilotCredential({
      environment: {
        COPILOT_GITHUB_TOKEN: "copilot-override",
        GH_TOKEN: "gh-override",
        GITHUB_TOKEN: "actions-override",
      },
      readGhToken,
    })).resolves.toEqual({
      token: "copilot-override",
      source: "environment",
    });
    expect(readGhToken).not.toHaveBeenCalled();
  });

  it("trims the active GitHub CLI token and fails generically when unavailable", async () => {
    await expect(resolveCopilotCredential({
      environment: {},
      readGhToken: async () => " gh-keyring-token\n",
    })).resolves.toEqual({
      token: "gh-keyring-token",
      source: "gh-cli",
    });
    for (const readGhToken of [
      async () => undefined,
      async () => "   ",
      async () => {
        throw new Error("secret child-process details");
      },
    ]) {
      await expect(resolveCopilotCredential({
        environment: {},
        readGhToken,
      })).rejects.toThrow("GitHub authentication is unavailable");
      await expect(resolveCopilotCredential({
        environment: {},
        readGhToken,
      })).rejects.not.toThrow("secret child-process details");
    }
  });

  it("passes the resolved token directly into an isolated empty-mode client", async () => {
    vi.stubEnv("UNRELATED_SECRET", "must-not-be-forwarded");
    const token = "secret-marker-must-not-appear";

    const transport = await openCopilotTransport(
      "mock-model",
      async () => ({ token, source: "gh-cli" }),
    );
    try {
      const options = sdkMocks.clientOptions[0];
      const expectedEnvironment: Record<string, string | undefined> =
        Object.fromEntries(
        ["PATH", "TMPDIR"]
          .flatMap(name => process.env[name] ? [[name, process.env[name]]] : []),
      );
      if (typeof options?.baseDirectory === "string") {
        expectedEnvironment.HOME = options.baseDirectory;
      }

      expect(options).toMatchObject({
        mode: "empty",
        gitHubToken: token,
        useLoggedInUser: false,
        env: expectedEnvironment,
      });
      expect(options?.env).not.toHaveProperty("COPILOT_GITHUB_TOKEN");
      expect(options?.env).not.toHaveProperty("GH_TOKEN");
      expect(options?.env).not.toHaveProperty("GITHUB_TOKEN");
      expect(options?.env).not.toHaveProperty("UNRELATED_SECRET");
      expect(options?.env?.HOME).toBe(options?.baseDirectory);
      expect(options?.baseDirectory).toBe(options?.workingDirectory);
      expect(options?.baseDirectory).not.toBe(process.env.HOME);
    } finally {
      await transport.close();
    }
  });

  it("locks every ambient session capability off in empty mode", async () => {
    const transport = await openCopilotTransport(
      "mock-model",
      async () => ({ token: "test-token", source: "environment" }),
    );
    try {
      await expect(transport.complete("trusted system", "evidence"))
        .resolves.toEqual({ content: "ok", usage: undefined });
      expect(sdkMocks.sessionOptions[0]).toMatchObject({
        model: "mock-model",
        reasoningEffort: "low",
        availableTools: [],
        tools: [],
        mcpServers: {},
        skillDirectories: [],
        pluginDirectories: [],
        instructionDirectories: [],
        customAgents: [],
        skipCustomInstructions: true,
        enableConfigDiscovery: false,
        enableSkills: false,
        enableFileHooks: false,
        enableHostGitOperations: false,
        enableSessionStore: false,
        enableOnDemandInstructionDiscovery: false,
        enableSessionTelemetry: false,
        skipEmbeddingRetrieval: true,
        embeddingCacheStorage: "in-memory",
        infiniteSessions: { enabled: false },
        systemMessage: { mode: "replace", content: "trusted system" },
      });
      const permission = sdkMocks.sessionOptions[0]?.onPermissionRequest;
      expect(typeof permission).toBe("function");
      expect((permission as () => unknown)()).toEqual({
        kind: "denied-by-rules",
        rules: [],
      });
      const hooks = sdkMocks.sessionOptions[0]?.hooks as {
        onErrorOccurred?: () => unknown;
      };
      expect(hooks.onErrorOccurred?.()).toEqual({
        errorHandling: "abort",
        retryCount: 0,
      });
      expect(sdkMocks.deleteSession).toHaveBeenCalledWith("auth-test-session");
    } finally {
      await transport.close();
    }
  });

  it("reports SDK authentication guidance without exposing credentials", async () => {
    sdkMocks.getAuthStatus.mockResolvedValueOnce({ isAuthenticated: false });
    const token = "secret-marker-must-not-appear";

    const failure = openCopilotTransport(
      "mock-model",
      async () => ({ token, source: "gh-cli" }),
    );
    await expect(failure).rejects.toThrow("run `gh auth login`");
    await expect(failure).rejects.not.toThrow(token);
    expect(sdkMocks.stop).toHaveBeenCalledOnce();
  });
});

describe("Ax custom SDK provider contract (offline)", () => {
  it("forwards cancellation and rejects unsupported tools/streaming", async () => {
    const complete = vi.fn(async (_system: string, _user: string, _signal?: AbortSignal) => ({ content: "ok" }));
    const ai = copilotAI({ complete, close: async () => { } });
    const controller = new AbortController();
    await ai.chat({ chatPrompt: [{ role: "user", content: "data" }] }, { abortSignal: controller.signal });
    expect(complete.mock.calls[0]?.[2]).toBe(controller.signal);
    await expect(ai.chat({ chatPrompt: [], functions: [{ name: "tool", description: "" }] })).rejects.toThrow("tools");
    await expect(ai.chat({ chatPrompt: [] }, { stream: true })).rejects.toThrow("Streaming");
    await expect(ai.chat({ chatPrompt: [], responseFormat: { type: "json_schema", schema: {} } })).rejects.toThrow("Native structured");
    await expect(ai.chat({ chatPrompt: [], model: "different-model" })).rejects.toThrow("pinned");
  });

  it("accepts Ax text-part correction messages and still rejects media", async () => {
    const complete = vi.fn(async (_system: string, user: string) => ({
      content: user,
    }));
    const ai = copilotAI({ complete, close: async () => { } });

    await ai.chat({
      chatPrompt: [{
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: " second" },
        ],
      }],
    });
    expect(complete.mock.calls[0]?.[1]).toContain(
      "<user>\nfirst second\n</user>",
    );
    await expect(ai.chat({
      chatPrompt: [{
        role: "user",
        content: [{
          type: "image",
          mimeType: "image/png",
          image: "ignored",
        }],
      }],
    })).rejects.toThrow("text-only message arrays");
  });

  it("lets Ax perform one validation correction through the production path", async () => {
    const taxonomy = await loadTaxonomy(
      new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
      { handlers: createHandlerRegistry() },
    );
    const atif = parseScopeAtif({
      schema_version: "ATIF-v1.8",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [{ step_id: 1, source: "user", message: "Test." }],
    });
    const complete = vi.fn()
      .mockResolvedValueOnce({
        content: `Observation: ${JSON.stringify({
          state: "completed",
          observed: true,
          occurrences: [{
            evidence: [{ role: "step", path: "$.steps[99]" }],
          }],
        })}`,
      })
      .mockImplementationOnce(async (_system: string, user: string) => {
        expect(user).toContain("unresolved_reference");
        return {
          content: `Observation: ${JSON.stringify({
            state: "completed",
            observed: true,
            occurrences: [{
              evidence: [{ role: "step", path: "$.steps[0]" }],
            }],
          })}`,
        };
      });
    const [result] = await evaluate(
      { atif, taxonomy },
      ["test-observation"],
      taxonomyPromptExecutor(
        copilotAI({ complete, close: async () => { } }),
      ),
    );

    expect(result).toMatchObject({
      status: "succeeded",
      implementation: {
        attempts: [
          { attempt: 1, kind: "initial", outcome: "invalid_output" },
          { attempt: 2, kind: "repair", outcome: "succeeded" },
        ],
      },
      result: {
        state: "completed",
        observed: true,
      },
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("lets Ax correct malformed observation JSON exactly once", async () => {
    const taxonomy = await loadTaxonomy(
      new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
      { handlers: createHandlerRegistry() },
    );
    const atif = parseScopeAtif({
      schema_version: "ATIF-v1.8",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [{ step_id: 1, source: "user", message: "Test." }],
    });
    const complete = vi.fn()
      .mockResolvedValueOnce({ content: "Observation: {not-json" })
      .mockResolvedValueOnce({
        content: `Observation: ${JSON.stringify({
          state: "completed",
          observed: false,
        })}`,
      });

    const [result] = await evaluate(
      { atif, taxonomy },
      ["test-observation"],
      taxonomyPromptExecutor(
        copilotAI({ complete, close: async () => { } }),
      ),
    );
    expect(result).toMatchObject({
      status: "succeeded",
      implementation: {
        attempts: [
          { attempt: 1, kind: "initial", outcome: "invalid_output" },
          { attempt: 2, kind: "repair", outcome: "succeeded" },
        ],
      },
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("corrects a capitalized nested Evidence key without accepting it", async () => {
    const taxonomy = await loadTaxonomy(
      new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
      { handlers: createHandlerRegistry() },
    );
    const atif = parseScopeAtif({
      schema_version: "ATIF-v1.8",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [{ step_id: 1, source: "user", message: "Test." }],
    });
    const complete = vi.fn()
      .mockResolvedValueOnce({
        content: `Observation: ${JSON.stringify({
          state: "completed",
          observed: true,
          occurrences: [{
            Evidence: [{ role: "step", path: "$.steps[0]" }],
          }],
        })}`,
      })
      .mockImplementationOnce(async (_system: string, user: string) => {
        expect(user).toContain(
          "JSON property-name casing is significant",
        );
        expect(user).toContain("$.occurrences[0].evidence");
        expect(user).toContain("'Evidence'");
        return {
          content: `Observation: ${JSON.stringify({
            state: "completed",
            observed: true,
            occurrences: [{
              evidence: [{ role: "step", path: "$.steps[0]" }],
            }],
          })}`,
        };
      });

    const [result] = await evaluate(
      { atif, taxonomy },
      ["test-observation"],
      taxonomyPromptExecutor(
        copilotAI({ complete, close: async () => { } }),
      ),
    );
    expect(result.status).toBe("succeeded");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      state: "completed",
      observed: false,
    },
    {
      state: "indeterminate",
      reason: "Evidence is incomplete.",
    },
    {
      state: "inapplicable",
      reason: "The behavior does not apply.",
    },
  ])("accepts every non-positive assessment variant in one completion", async candidate => {
    const taxonomy = await loadTaxonomy(
      new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
      { handlers: createHandlerRegistry() },
    );
    const atif = parseScopeAtif({
      schema_version: "ATIF-v1.8",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [{ step_id: 1, source: "user", message: "Test." }],
    });
    const complete = vi.fn(async () => ({
      content: `Observation: ${JSON.stringify(candidate)}`,
    }));

    const [result] = await evaluate(
      { atif, taxonomy },
      ["test-observation"],
      taxonomyPromptExecutor(
        copilotAI({ complete, close: async () => { } }),
      ),
    );
    expect(result).toMatchObject({
      status: "succeeded",
      result: candidate,
      implementation: {
        attempts: [{
          attempt: 1,
          kind: "initial",
          outcome: "succeeded",
        }],
      },
    });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("rejects double encoding, exhausts after two outputs, and redacts raw Ax errors", async () => {
    const taxonomy = await loadTaxonomy(
      new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
      { handlers: createHandlerRegistry() },
    );
    const atif = parseScopeAtif({
      schema_version: "ATIF-v1.8",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [{ step_id: 1, source: "user", message: "Test." }],
    });
    const rawMarker = "RAW-CANDIDATE-MUST-NOT-PERSIST";
    const complete = vi.fn()
      .mockResolvedValueOnce({
        content: `Observation: ${JSON.stringify(
          JSON.stringify({ state: "completed", observed: false }),
        )}`,
      })
      .mockResolvedValueOnce({
        content: `Observation: ${JSON.stringify({
          observed: false,
          secret: rawMarker,
        })}`,
      });
    const [result] = await evaluate(
      { atif, taxonomy },
      ["test-observation"],
      taxonomyPromptExecutor(
        copilotAI({ complete, close: async () => { } }),
      ),
    );

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "invalid_output",
      },
      implementation: {
        attempts: [
          { attempt: 1, kind: "initial", outcome: "invalid_output" },
          { attempt: 2, kind: "repair", outcome: "invalid_output" },
        ],
      },
    });
    expect(
      result.status === "failed"
        ? result.error.validation_errors?.map(item => item.code)
        : [],
    ).toContain("schema_mismatch");
    expect(JSON.stringify(result)).not.toContain(rawMarker);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["wrong envelope depth", {
      observation: { state: "completed", observed: false },
    }],
    ["extra assessment key", {
      state: "completed",
      observed: false,
      extra: true,
    }],
    ["wrong nested evidence shape", {
      state: "completed",
      observed: true,
      occurrences: [{ evidence: { role: "step", path: "$.steps[0]" } }],
    }],
  ])("corrects %s through the shared assertion", async (_label, invalid) => {
    const taxonomy = await loadTaxonomy(
      new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
      { handlers: createHandlerRegistry() },
    );
    const atif = parseScopeAtif({
      schema_version: "ATIF-v1.8",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [{ step_id: 1, source: "user", message: "Test." }],
    });
    const complete = vi.fn()
      .mockResolvedValueOnce({
        content: `Observation: ${JSON.stringify(invalid)}`,
      })
      .mockResolvedValueOnce({
        content: `Observation: ${JSON.stringify({
          state: "completed",
          observed: false,
        })}`,
      });

    const [result] = await evaluate(
      { atif, taxonomy },
      ["test-observation"],
      taxonomyPromptExecutor(
        copilotAI({ complete, close: async () => { } }),
      ),
    );
    expect(result.status).toBe("succeeded");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("never retries a transport failure", async () => {
    const taxonomy = await loadTaxonomy(
      new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
      { handlers: createHandlerRegistry() },
    );
    const atif = parseScopeAtif({
      schema_version: "ATIF-v1.8",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [{ step_id: 1, source: "user", message: "Test." }],
    });
    const complete = vi.fn(async () => {
      throw new Error("transport unavailable");
    });
    const [result] = await evaluate(
      { atif, taxonomy },
      ["test-observation"],
      taxonomyPromptExecutor(
        copilotAI({ complete, close: async () => { } }),
      ),
    );

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "execution_failed" },
      implementation: {
        attempts: [{
          attempt: 1,
          kind: "initial",
          outcome: "execution_failed",
        }],
      },
    });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("records a failed correction transport after one invalid completion", async () => {
    const taxonomy = await loadTaxonomy(
      new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
      { handlers: createHandlerRegistry() },
    );
    const atif = parseScopeAtif({
      schema_version: "ATIF-v1.8",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [{ step_id: 1, source: "user", message: "Test." }],
    });
    const complete = vi.fn()
      .mockResolvedValueOnce({
        content: `Observation: ${JSON.stringify({ observed: false })}`,
      })
      .mockRejectedValueOnce(new Error("correction transport failed"));
    const [result] = await evaluate(
      { atif, taxonomy },
      ["test-observation"],
      taxonomyPromptExecutor(
        copilotAI({ complete, close: async () => { } }),
      ),
    );

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "execution_failed",
      },
      implementation: {
        attempts: [
          { attempt: 1, kind: "initial", outcome: "invalid_output" },
          { attempt: 2, kind: "repair", outcome: "execution_failed" },
        ],
      },
    });
    expect(
      result.status === "failed"
        ? result.error.validation_errors?.map(item => item.code)
        : [],
    ).toContain("schema_mismatch");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("reports the terminal parser failure instead of stale assertion diagnostics", async () => {
    const taxonomy = await loadTaxonomy(
      new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
      { handlers: createHandlerRegistry() },
    );
    const atif = parseScopeAtif({
      schema_version: "ATIF-v1.8",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [{ step_id: 1, source: "user", message: "Test." }],
    });
    const complete = vi.fn()
      .mockResolvedValueOnce({
        content: `Observation: ${JSON.stringify({ observed: false })}`,
      })
      .mockResolvedValueOnce({ content: "Observation: {still-bad" });
    const [result] = await evaluate(
      { atif, taxonomy },
      ["test-observation"],
      taxonomyPromptExecutor(
        copilotAI({ complete, close: async () => { } }),
      ),
    );

    expect(
      result.status === "failed"
        ? result.error.validation_errors
        : undefined,
    ).toEqual([{
      code: "invalid_json",
      output_path: "$.observation",
      message: "Ax could not parse the observation field as one JSON value.",
    }]);
  });

  it("routes ordering-constraint diagnostics through the Ax correction", async () => {
    const root = new URL(
      "../conformance/trajectory-taxonomy-format/",
      import.meta.url,
    );
    const taxonomy = await loadTaxonomy(
      new URL("valid/taxonomy.yaml", root).pathname,
      { handlers: createHandlerRegistry() },
    );
    const atif = parseScopeAtif(JSON.parse(await readFile(
      new URL("valid/atif-v17.json", root),
      "utf8",
    )) as unknown);
    const complete = vi.fn()
      .mockImplementationOnce(async (system: string) => {
        expect(system).toContain('"required":["evidence"]');
        expect(system).not.toContain('"required":["Evidence"]');
        expect(system).toContain(
          "Assessment JSON property-name casing is significant.",
        );
        return {
          content: `Observation: ${JSON.stringify({
            state: "completed",
            observed: true,
            occurrences: [{
              evidence: [
                {
                  role: "returned_content",
                  path: "$.steps[1].observation.results[0]",
                },
                { role: "misuse", path: "$.steps[0]" },
              ],
            }],
          })}`,
        };
      })
      .mockImplementationOnce(async (_system: string, user: string) => {
        expect(user).toContain(
          "JSON property-name casing is significant",
        );
        expect(user).toContain(
          "evidence, observed, occurrences, path, reason, role, state",
        );
        expect(user).toContain("reference_constraint_mismatch");
        return {
          content: `Observation: ${JSON.stringify({
            state: "completed",
            observed: true,
            occurrences: [{
              evidence: [
                {
                  role: "returned_content",
                  path: "$.steps[1].observation.results[0]",
                },
                { role: "misuse", path: "$.steps[2]" },
              ],
            }],
          })}`,
        };
      });

    const [result] = await evaluate(
      { atif, taxonomy },
      ["content"],
      taxonomyPromptExecutor(
        copilotAI({ complete, close: async () => { } }),
      ),
    );
    expect(result.status).toBe("succeeded");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("routes evidence-type diagnostics through the Ax correction", async () => {
    const root = new URL(
      "../conformance/trajectory-taxonomy-format/",
      import.meta.url,
    );
    const taxonomy = await loadTaxonomy(
      new URL("valid/taxonomy.yaml", root).pathname,
      { handlers: createHandlerRegistry() },
    );
    const atif = parseScopeAtif(JSON.parse(await readFile(
      new URL("valid/atif-v17.json", root),
      "utf8",
    )) as unknown);
    const complete = vi.fn()
      .mockResolvedValueOnce({
        content: `Observation: ${JSON.stringify({
          state: "completed",
          observed: true,
          occurrences: [{
            evidence: [
              { role: "call", path: "$.steps[1]" },
              {
                role: "issue",
                path:
                  "$.steps[1].tool_calls[0].extra.scope.input_validation.issues[0]",
              },
            ],
          }],
        })}`,
      })
      .mockImplementationOnce(async (_system: string, user: string) => {
        expect(user).toContain("reference_type_mismatch");
        return {
          content: `Observation: ${JSON.stringify({
            state: "completed",
            observed: false,
          })}`,
        };
      });

    const [result] = await evaluate(
      { atif, taxonomy },
      ["malformed"],
      taxonomyPromptExecutor(
        copilotAI({ complete, close: async () => { } }),
      ),
    );
    expect(result.status).toBe("succeeded");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("keeps concurrent validation contexts isolated per forward call", async () => {
    const taxonomy = await loadTaxonomy(
      new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
      { handlers: createHandlerRegistry() },
    );
    const twoSteps = parseScopeAtif({
      schema_version: "ATIF-v1.8",
      session_id: "two-steps",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [
        { step_id: 1, source: "user", message: "one" },
        { step_id: 2, source: "agent", message: "two" },
      ],
    });
    const oneStep = parseScopeAtif({
      schema_version: "ATIF-v1.8",
      session_id: "one-step",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [{ step_id: 1, source: "user", message: "one" }],
    });
    const complete = vi.fn(async (_system: string, user: string) => {
      await new Promise(resolve => setTimeout(resolve, 2));
      const path = user.includes("two-steps")
        ? "$.steps[1]"
        : "$.steps[0]";
      return {
        content: `Observation: ${JSON.stringify({
          state: "completed",
          observed: true,
          occurrences: [{
            evidence: [{ role: "step", path }],
          }],
        })}`,
      };
    });
    const executor = taxonomyPromptExecutor(
      copilotAI({ complete, close: async () => { } }),
    );

    const [first, second] = await Promise.all([
      evaluate(
        { atif: twoSteps, taxonomy },
        ["test-observation"],
        executor,
      ),
      evaluate(
        { atif: oneStep, taxonomy },
        ["test-observation"],
        executor,
      ),
    ]);
    expect(first[0].status).toBe("succeeded");
    expect(second[0].status).toBe("succeeded");
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
describe("SDK lifecycle failures (offline)", () => {
  it("closes student and teacher independently and preserves the original optimization error", async () => {
    const student = {
      close: vi.fn(async () => {
        throw new Error("student cleanup");
      })
    };
    const teacher = {
      close: vi.fn(async () => {
        throw new Error("teacher cleanup");
      })
    };
    const failure: unknown = await closeTransports([student, teacher], new Error("optimization failed")).catch(e => e);
    expect(student.close).toHaveBeenCalledOnce();
    expect(teacher.close).toHaveBeenCalledOnce();
    if (!(failure instanceof AggregateError)) throw new Error("Expected aggregate cleanup failure");
    expect(failure.errors.map((e: Error) => e.message)).toEqual(["optimization failed", "student cleanup", "teacher cleanup"]);
  });
  it("preserves inference and independent cleanup failures", async () => {
    const { session, deleted } = fixture();
    vi.mocked(session.sendAndWait).mockRejectedValue(new Error("primary inference failure"));
    vi.mocked(session.disconnect).mockRejectedValue(new Error("disconnect failure"));
    deleted.mockRejectedValue(new Error("delete failure"));

    const failure: unknown = await executeSdkCall(session, "input", deleted)
      .catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (failure instanceof AggregateError) {
      expect(failure.errors.map((error: Error) => error.message)).toEqual([
        "primary inference failure",
        "disconnect failure",
        "delete failure",
      ]);
    }
    expect(session.abort).toHaveBeenCalled();
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(deleted).toHaveBeenCalledOnce();
  });
  it("aborts on caller cancellation and timeout, then cleans up", async () => {
    for (const cancelled of [true, false]) {
      const { session, deleted } = fixture();
      vi.mocked(session.sendAndWait).mockImplementation(() => new Promise(() => { }));
      const controller = new AbortController();
      const promise = executeSdkCall(
        session,
        "input",
        deleted,
        controller.signal,
        10,
      );
      if (cancelled) setTimeout(() => controller.abort(), 1);
      await expect(promise).rejects.toThrow(cancelled ? "cancelled" : "timed out");
      expect(session.abort).toHaveBeenCalled();
      expect(session.disconnect).toHaveBeenCalledOnce();
      expect(deleted).toHaveBeenCalledOnce();
    }
  });
  it("never sends after pre-cancellation", async () => {
    const { session, deleted } = fixture();
    const controller = new AbortController();
    controller.abort();

    await expect(executeSdkCall(
      session,
      "input",
      deleted,
      controller.signal,
    )).rejects.toThrow("cancelled before");
    expect(session.sendAndWait).not.toHaveBeenCalled();
  });
  it("aborts any model failure immediately rather than inviting a runtime retry", async () => {
    const { session, deleted } = fixture();
    vi.mocked(session.on).mockImplementation(handler => {
      vi.mocked(session.sendAndWait).mockImplementation(async () => {
        handler({ type: "model.call_failure", data: {} } as SessionEvent);
        throw new Error("model failed");
      });
      return () => { };
    });
    await expect(executeSdkCall(session, "input", deleted))
      .rejects.toThrow("model failed");
    expect(session.abort).toHaveBeenCalled();
  });
  it("returns successful content and reported usage", async () => {
    const { session, deleted } = fixture();
    vi.mocked(session.sendAndWait).mockResolvedValue({
      id: "event-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "assistant.message",
      data: { messageId: "message-1", content: "response" },
    });

    await expect(executeSdkCall(session, "input", deleted))
      .resolves.toEqual({ content: "response", usage: undefined });
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(deleted).toHaveBeenCalledOnce();
  });
});
