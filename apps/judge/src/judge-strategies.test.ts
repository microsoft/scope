// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  IndependentStrategy,
  BundledStrategy,
  TOOL_OUTPUTS_GUIDANCE,
  STICKY_PASS_GUIDANCE,
  buildEvidenceGuidance,
  buildPriorResultsSection,
  isWithinWorkspace,
  JUDGE_AVAILABLE_TOOLS,
  JUDGE_EXCLUDED_TOOLS,
} from "./judge-strategies.js";

/**
 * Test subclass that exposes the protected `createFileTools` so we can assert
 * properties of the judge's workspace-inspection tools without running a real
 * Copilot session.
 */
class TestableStrategy extends IndependentStrategy {
  publicCreateFileTools(workspacePath: string) {
    return this.createFileTools(workspacePath);
  }
  publicCreateToolOutputTools(iterationToolCalls: any[]) {
    return this.createToolOutputTools(iterationToolCalls);
  }
  publicCreateAgentResponseTool(response: string) {
    return this.createAgentResponseTool(response);
  }
  publicBuildSessionConfig(tools: any[], systemPrompt: string) {
    return this.buildSessionConfig(tools, systemPrompt);
  }
  publicBuildSystemPrompt(hasToolOutputs: boolean, hasAgentResponse?: boolean) {
    return (this as any).buildSystemPrompt(undefined, hasToolOutputs, hasAgentResponse);
  }
  publicBuildUserPrompt(
    criterion: { id: string; prompt: string },
    history: any[] = []
  ) {
    return (this as any).buildUserPrompt(criterion, history);
  }
}

function toolMap(workspacePath: string) {
  const strategy = new TestableStrategy("test-model");
  const tools = strategy.publicCreateFileTools(workspacePath);
  return new Map(tools.map((t) => [t.name, t]));
}

const stubInvocation = {
  sessionId: "test-session",
  toolCallId: "test-call",
  toolName: "test-tool",
  arguments: {},
};

async function callTool(
  workspacePath: string,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const tool = toolMap(workspacePath).get(name);
  if (!tool?.handler) throw new Error(`tool ${name} has no handler`);
  return (tool.handler as (a: unknown, b: unknown) => unknown)(args, stubInvocation);
}

describe("judge file tools", () => {
  const strategy = new TestableStrategy("test-model");
  const tools = strategy.publicCreateFileTools("/tmp/workspace");

  it("exposes the expected read-only inspection tools", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ["file_exists", "list_directory", "read_file", "search_files"].sort()
    );
  });

  // Regression guard for scope-doc#64: under the v3 Copilot SDK the headless
  // judge cannot answer interactive permission prompts, so any tool without
  // skipPermission is denied at execution time ("could not request permission
  // from user"), silently breaking all workspace inspection.
  it("marks every tool to skip the permission prompt", () => {
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.skipPermission, `${tool.name} must skip the permission prompt`).toBe(true);
    }
  });
});

describe("judge tool-output tools (issues #1125, #1255)", () => {
  const strategy = new TestableStrategy("test-model");
  // Two iterations: a one-time bootstrap in iteration 1, a build in iteration 2.
  const iterationToolCalls = [
    {
      iteration: 1,
      toolCalls: [
        {
          id: "1",
          name: "bash",
          arguments: { command: "npx create-app my-app" },
          response: "scaffolded project into my-app/",
          timestamp: "",
        },
      ],
    },
    {
      iteration: 2,
      toolCalls: [
        {
          id: "2",
          name: "bash",
          arguments: { command: "npm run build" },
          response: "build ok",
          timestamp: "",
        },
      ],
    },
  ];

  async function call(name: string, args: Record<string, unknown>): Promise<any> {
    const tools = strategy.publicCreateToolOutputTools(iterationToolCalls);
    const tool = tools.find((t) => t.name === name);
    if (!tool?.handler) throw new Error(`tool ${name} has no handler`);
    return (tool.handler as (a: unknown, b: unknown) => unknown)(args, stubInvocation);
  }

  const tools = strategy.publicCreateToolOutputTools(iterationToolCalls);

  it("exposes list_tool_calls, search_tool_outputs and get_tool_output", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_tool_output", "list_tool_calls", "search_tool_outputs"]);
  });

  // Regression guard for scope #1125: headless, any tool without skipPermission
  // is denied at execution time ("could not request permission from user"). When
  // this affected the tool-output tools, the judge could never see the coding
  // agent's captured build/test output and wrongly demanded on-disk proof files.
  it("marks every tool-output tool to skip the permission prompt", () => {
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.skipPermission, `${tool.name} must skip the permission prompt`).toBe(true);
    }
  });

  // The core of #1255: list_tool_calls spans EVERY iteration of the run, not just
  // the one being judged, and labels each call with its iteration.
  it("list_tool_calls returns calls from all iterations, each labeled by iteration", async () => {
    const res = await call("list_tool_calls", {});
    expect(res.totalCalls).toBe(2);
    expect(res.iterationsCovered).toEqual([1, 2]);
    const byIter = new Map(res.calls.map((c: any) => [c.iteration, c.name]));
    expect(byIter.get(1)).toBe("bash");
    expect(byIter.get(2)).toBe("bash");
  });

  it("list_tool_calls can filter to a single iteration", async () => {
    const res = await call("list_tool_calls", { iteration: 1 });
    expect(res.filteredCalls).toBe(1);
    expect(res.calls[0].iteration).toBe(1);
    expect(res.calls[0].arguments.command).toContain("create-app");
  });

  it("list_tool_calls can filter by a query substring over name/arguments", async () => {
    const res = await call("list_tool_calls", { query: "create-app" });
    expect(res.filteredCalls).toBe(1);
    expect(res.calls[0].index).toBe(0);
  });

  // The key tool for one-time-action criteria: a single search answers "was this
  // command ever run in the run?" — even if it ran in an earlier iteration.
  it("search_tool_outputs finds a one-time action from an earlier iteration", async () => {
    const res = await call("search_tool_outputs", { pattern: "create-app" });
    expect(res.matchCount).toBe(1);
    expect(res.matches[0].iteration).toBe(1);
    expect(res.matches[0].matchedIn).toBe("arguments");
  });

  it("search_tool_outputs matches against captured response text", async () => {
    const res = await call("search_tool_outputs", { pattern: "scaffolded" });
    expect(res.matchCount).toBe(1);
    expect(res.matches[0].matchedIn).toBe("response");
    expect(res.matches[0].iteration).toBe(1);
  });

  it("get_tool_output returns a call's full output with its iteration by global index", async () => {
    const res = await call("get_tool_output", { index: 1 });
    expect(res.iteration).toBe(2);
    expect(res.name).toBe("bash");
    expect(res.response).toBe("build ok");
  });

  it("get_tool_output reports a clear error for an out-of-range index", async () => {
    const res = await call("get_tool_output", { index: 99 });
    expect(res.error).toContain("No tool call at index 99");
  });

  it("reports empty history gracefully when no iterations captured tool calls", async () => {
    const emptyStrategy = new TestableStrategy("test-model");
    const [list] = emptyStrategy.publicCreateToolOutputTools([]);
    const res: any = await (list.handler as any)({}, stubInvocation);
    expect(res.totalCalls).toBe(0);
    expect(res.calls).toEqual([]);
  });
});

describe("judge agent-response tool (issue #1136)", () => {
  const strategy = new TestableStrategy("test-model");

  async function callAgentResponse(response: string): Promise<any> {
    const [tool] = strategy.publicCreateAgentResponseTool(response);
    if (!tool?.handler) throw new Error("read_agent_response has no handler");
    return (tool.handler as (a: unknown, b: unknown) => unknown)({}, stubInvocation);
  }

  it("exposes a single read_agent_response tool", () => {
    const tools = strategy.publicCreateAgentResponseTool("the agent said hello");
    expect(tools.map((t) => t.name)).toEqual(["read_agent_response"]);
  });

  // Same headless permission rationale as the file and tool-output tools: a tool
  // without skipPermission is denied at execution time, so the judge could never
  // read the agent's response. See scope #1125, #1136.
  it("marks read_agent_response to skip the permission prompt", () => {
    const [tool] = strategy.publicCreateAgentResponseTool("x");
    expect(tool.skipPermission).toBe(true);
  });

  it("takes no parameters", () => {
    const [tool] = strategy.publicCreateAgentResponseTool("x");
    const params = tool.parameters as { required?: string[]; properties?: Record<string, unknown> };
    expect(params.required ?? []).toEqual([]);
    expect(params.properties ?? {}).toEqual({});
  });

  it("returns the full response text untruncated under the cap", async () => {
    const result = await callAgentResponse("The factorial of 5 is 120.");
    expect(result.hasResponse).toBe(true);
    expect(result.response).toBe("The factorial of 5 is 120.");
    expect(result.truncated).toBe(false);
  });

  it("reports no response for an empty string", async () => {
    const result = await callAgentResponse("");
    expect(result.hasResponse).toBe(false);
    expect(result.response).toBe("");
  });

  // The full-text cap mirrors get_tool_output (FULL_LIMIT = 100_000): it bounds
  // the payload while still delivering far more than the lossy 300-500 char
  // prior-iteration truncation that motivated #1136.
  it("truncates and flags responses that exceed the safety cap", async () => {
    const huge = "a".repeat(100_001);
    const result = await callAgentResponse(huge);
    expect(result.hasResponse).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.totalLength).toBe(100_001);
    expect(result.response.length).toBe(100_000);
  });
});

describe("judge evidence guidance — agent response (issue #1136)", () => {
  // buildEvidenceGuidance composes the system-prompt guidance from whichever
  // evidence sources exist. The no-code / Q&A case has ZERO tool calls but a
  // non-empty response, so the guidance + read_agent_response tool must appear
  // even when hasToolOutputs is false.

  it("names read_agent_response and frames the response as authoritative when present", () => {
    const g = buildEvidenceGuidance({ hasToolOutputs: false, hasAgentResponse: true });
    expect(g).toContain("## Your Tools");
    expect(g).toContain("read_agent_response");
    expect(g).toContain("## How to Judge");
    expect(g.toLowerCase()).toContain("equally authoritative");
    // It must NOT advertise tool-output tools that aren't available here.
    expect(g).not.toContain("list_tool_calls");
    expect(g).not.toContain("search_tool_outputs");
    expect(g).not.toContain("get_tool_output");
  });

  it("lists all three sources when both tool outputs and a response are present", () => {
    const g = buildEvidenceGuidance({ hasToolOutputs: true, hasAgentResponse: true });
    expect(g).toContain("list_tool_calls");
    expect(g).toContain("search_tool_outputs");
    expect(g).toContain("get_tool_output");
    expect(g).toContain("read_agent_response");
    expect(g.toLowerCase()).toContain("equally authoritative");
  });

  it("is byte-identical to TOOL_OUTPUTS_GUIDANCE for the tool-outputs-only case", () => {
    const g = buildEvidenceGuidance({ hasToolOutputs: true, hasAgentResponse: false });
    expect(g).toBe(TOOL_OUTPUTS_GUIDANCE);
    expect(g).not.toContain("read_agent_response");
  });

  it("injects guidance into the system prompt when only a response is present (no tool outputs)", () => {
    const sys = new TestableBundledStrategy("test-model").publicBuildSystemPrompt(false, true);
    expect(sys).toContain("read_agent_response");
    expect(sys).toContain("## How to Judge");
  });

  it("injects guidance for the IndependentStrategy when only a response is present", () => {
    const sys = new TestableStrategy("test-model").publicBuildSystemPrompt(false, true);
    expect(sys).toContain("read_agent_response");
    expect(sys).toContain("## How to Judge");
  });

  it("omits all evidence guidance when neither tool outputs nor a response exist", () => {
    const sys = new TestableBundledStrategy("test-model").publicBuildSystemPrompt(false, false);
    expect(sys).not.toContain("read_agent_response");
    expect(sys).not.toContain("## How to Judge");
  });

  // Backward-compat guard: the `## Instructions` step 1 is now a single,
  // source-agnostic line in EVERY configuration. Because it never names a
  // specific source, it can't point a criterion at evidence the judge lacks
  // (the pre-#1136 bug). Source/tool specifics live in the gated evidence
  // section (buildEvidenceGuidance), which the byte-identical TOOL_OUTPUTS_GUIDANCE
  // test above still pins for the tool-outputs-only case.
  it("uses one source-agnostic '## Instructions' step 1 in every configuration (both strategies)", () => {
    const expected = "1. Gather evidence from every available source.";
    const step1 = (sys: string) => sys.split("\n").find((l) => l.startsWith("1. "));

    for (const hasToolOutputs of [true, false]) {
      for (const hasAgentResponse of [true, false]) {
        const bundled = new TestableBundledStrategy("test-model").publicBuildSystemPrompt(
          hasToolOutputs,
          hasAgentResponse
        );
        const independent = new TestableStrategy("test-model").publicBuildSystemPrompt(
          hasToolOutputs,
          hasAgentResponse
        );
        expect(step1(bundled)).toBe(expected);
        expect(step1(independent)).toBe(expected);
      }
    }
  });
});

describe("isWithinWorkspace", () => {
  it("accepts the root itself and nested paths", () => {
    expect(isWithinWorkspace("/tmp/ws", "/tmp/ws")).toBe(true);
    expect(isWithinWorkspace("/tmp/ws", "/tmp/ws/src/index.ts")).toBe(true);
    expect(isWithinWorkspace("/tmp/ws", "/tmp/ws/a/../b")).toBe(true);
  });

  it("rejects sibling directories that share a name prefix", () => {
    // The bug a plain startsWith() check would miss: /tmp/ws2 is NOT under /tmp/ws.
    expect(isWithinWorkspace("/tmp/ws", "/tmp/ws2")).toBe(false);
    expect(isWithinWorkspace("/tmp/ws", "/tmp/ws2/secret")).toBe(false);
  });

  it("rejects parent-traversal escapes", () => {
    expect(isWithinWorkspace("/tmp/ws", "/tmp/ws/../ws2/secret")).toBe(false);
    expect(isWithinWorkspace("/tmp/ws", "/tmp")).toBe(false);
    expect(isWithinWorkspace("/tmp/ws", "/etc/passwd")).toBe(false);
  });
});

describe("judge file tool handlers (workspace scoping)", () => {
  let parent: string;
  let workspace: string;
  let sibling: string;

  beforeAll(() => {
    parent = mkdtempSync(join(tmpdir(), "judge-tools-"));
    // Sibling shares the "ws" name prefix to exercise the boundary check.
    workspace = join(parent, "ws");
    sibling = join(parent, "ws2");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(workspace, "inside.txt"), "in-workspace");
    writeFileSync(join(sibling, "secret.txt"), "SECRET");
  });

  afterAll(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("read_file refuses to read a sibling-prefix path via ..", async () => {
    const result = (await callTool(workspace, "read_file", {
      path: "../ws2/secret.txt",
    })) as { error?: string; content?: string };
    expect(result.error).toBe("Path traversal not allowed");
    expect(result.content).toBeUndefined();
  });

  it("read_file reads a legitimate in-workspace file", async () => {
    const result = (await callTool(workspace, "read_file", {
      path: "inside.txt",
    })) as { content?: string };
    expect(result.content).toBe("in-workspace");
  });

  it("file_exists refuses a sibling-prefix path", async () => {
    const result = (await callTool(workspace, "file_exists", {
      path: "../ws2/secret.txt",
    })) as { error?: string };
    expect(result.error).toBe("Path traversal not allowed");
  });

  it("list_directory refuses a sibling-prefix path", async () => {
    const result = (await callTool(workspace, "list_directory", {
      path: "../ws2",
    })) as { error?: string };
    expect(result.error).toBe("Path traversal not allowed");
  });

  it("search_files does not execute shell metacharacters in the pattern", async () => {
    const marker = join(parent, "pwned");
    // If the pattern were interpolated into a shell, $(...) would create the file.
    await callTool(workspace, "search_files", { pattern: `$(touch ${marker})` });
    expect(existsSync(marker)).toBe(false);
  });

  it("search_files finds real matches in the workspace", async () => {
    const result = (await callTool(workspace, "search_files", {
      pattern: "in-workspace",
    })) as { matches: string[] };
    expect(result.matches.some((m) => m.includes("inside.txt"))).toBe(true);
  });
});

describe("judge session tool restriction (scope #1117)", () => {
  const strategy = new TestableStrategy("test-model");
  const config = strategy.publicBuildSessionConfig([], "system prompt");

  // The headless judge must never be handed the SDK's built-in execute tools
  // (bash/edit/...). Under mode:"copilot-cli" (the SDK default) those are
  // injected and are NOT skipPermission, so the model trying to run a command
  // itself gets denied with "could not request permission from user" and then
  // mis-reports it as the coder's result. Restricting to custom:* prevents this.
  it("restricts availableTools to custom tools only", () => {
    expect(config.availableTools).toEqual(["custom:*"]);
  });

  it("explicitly excludes built-in and MCP tools", () => {
    expect(config.excludedTools).toEqual(["builtin:*", "mcp:*"]);
  });

  it("never exposes the built-in bash tool to the judge", () => {
    const available = config.availableTools as string[];
    const excluded = config.excludedTools as string[];
    expect(available).not.toContain("builtin:*");
    expect(available).not.toContain("bash");
    // excludedTools wins over availableTools, so builtin:* is hard-disabled.
    expect(excluded).toContain("builtin:*");
  });

  it("uses a replace-mode system message with the provided prompt", () => {
    expect(config.systemMessage).toEqual({ mode: "replace", content: "system prompt" });
  });

  it("exports the filter constants used to build the config", () => {
    expect([...JUDGE_AVAILABLE_TOOLS]).toEqual(["custom:*"]);
    expect([...JUDGE_EXCLUDED_TOOLS]).toEqual(["builtin:*", "mcp:*"]);
  });
});

/**
 * Exposes the protected `buildSystemPrompt` / `buildUserPrompt` so we can assert
 * how captured tool outputs, criteria, and history are surfaced to the judge
 * without running a real Copilot session.
 */
class TestableBundledStrategy extends BundledStrategy {
  publicBuildSystemPrompt(hasToolOutputs: boolean, hasAgentResponse?: boolean) {
    return (this as any).buildSystemPrompt(undefined, hasToolOutputs, hasAgentResponse);
  }
  publicParseJsonResponse(response: string, criteria: { id: string; prompt: string }[]) {
    return (this as any).parseJsonResponse(response, criteria);
  }
  publicBuildUserPrompt(
    criteria: { id: string; prompt: string }[] = [
      { id: "c1", prompt: "does the code work" },
    ],
    history: any[] = []
  ) {
    return (this as any).buildUserPrompt(criteria, history);
  }
}

describe("BundledStrategy JSON parsing (issue #167)", () => {
  const criteria = [{ id: "c1", prompt: "criterion one" }];

  it("parses fenced JSON with nested objects", () => {
    const response = '```json\n{"results":[{"criterion":"c1","passed":true,"feedback":"details"}],"meta":{"tokens":1}}\n```';
    const result = new TestableBundledStrategy("test-model").publicParseJsonResponse(response, criteria);
    expect(result.allPassed).toBe(true);
    expect(result.results[0].evaluated).toBe(true);
  });

  it("ignores braces inside JSON strings", () => {
    const response = '{"results":[{"criterion":"c1","passed":true,"feedback":"mongoose } config { is present"}]} trailing text';
    const result = new TestableBundledStrategy("test-model").publicParseJsonResponse(response, criteria);
    expect(result.allPassed).toBe(true);
    expect(result.results[0].feedback).toContain("mongoose } config {");
  });

  it("treats truncated JSON as unevaluated", () => {
    const response = '```json\n{"results":[{"criterion":"c1","passed":false,"feedback":"truncated';
    const result = new TestableBundledStrategy("test-model").publicParseJsonResponse(response, criteria);
    expect(result.allPassed).toBe(false);
    expect(result.results[0].evaluated).toBe(false);
  });
});

describe("judge tool-outputs guidance (issue #1125)", () => {
  // The headless judge cannot run commands; it must decide from the codebase
  // plus the coding agent's captured tool outputs. The guidance must be generic
  // (not build/test specific) and must tell the judge to treat captured output
  // as authoritative instead of demanding the agent redo or re-prove the work.
  it("is generic, not tied to any one command type", () => {
    const g = TOOL_OUTPUTS_GUIDANCE.toLowerCase();
    expect(g).not.toMatch(/build\.log|build_proof|\bnpm run build\b/);
  });

  it("tells the judge it cannot run commands itself", () => {
    expect(TOOL_OUTPUTS_GUIDANCE.toLowerCase()).toContain("cannot run any commands");
  });

  it("names the judge's own read-only tools and disambiguates them from the agent's", () => {
    expect(TOOL_OUTPUTS_GUIDANCE).toContain("## Your Tools");
    expect(TOOL_OUTPUTS_GUIDANCE).toContain("read_file");
    expect(TOOL_OUTPUTS_GUIDANCE).toContain("list_tool_calls");
    expect(TOOL_OUTPUTS_GUIDANCE).toContain("search_tool_outputs");
    expect(TOOL_OUTPUTS_GUIDANCE).toContain("get_tool_output");
    expect(TOOL_OUTPUTS_GUIDANCE.toLowerCase()).toContain("codebase");
  });

  // #1255: the guidance must tell the judge the captured history spans the WHOLE
  // run and point one-time-action criteria at search_tool_outputs.
  it("frames the captured tool history as spanning the whole run", () => {
    const g = TOOL_OUTPUTS_GUIDANCE.toLowerCase();
    expect(g).toContain("entire run");
    expect(g).toContain("search_tool_outputs");
  });

  it("frames the codebase and captured outputs as equally authoritative and to be examined together", () => {
    expect(TOOL_OUTPUTS_GUIDANCE).toContain("## How to Judge");
    const g = TOOL_OUTPUTS_GUIDANCE.toLowerCase();
    expect(g).toContain("equally authoritative");
    expect(g).toContain("examine both");
  });

  it("treats captured output as the record of what happened and forbids redundant re-proving", () => {
    const g = TOOL_OUTPUTS_GUIDANCE.toLowerCase();
    expect(g).toContain("record of what happened");
    expect(g).toMatch(/redo or re-prove/);
  });

  it("overrides criteria wording that asks the judge to run commands", () => {
    const g = TOOL_OUTPUTS_GUIDANCE.toLowerCase();
    expect(g).toContain("criterion");
    expect(g).toMatch(/run, execute, or re-run/);
    expect(g).toContain("ignore that instruction");
  });

  it("includes the guidance in the system prompt when tool outputs are present", () => {
    const prompt = new TestableBundledStrategy("test-model").publicBuildSystemPrompt(true);
    expect(prompt).toContain(TOOL_OUTPUTS_GUIDANCE);
  });

  it("frames What to Evaluate around the agent's work and points at the user message", () => {
    const prompt = new TestableBundledStrategy("test-model").publicBuildSystemPrompt(true);
    expect(prompt).toContain("## What to Evaluate");
    expect(prompt).toMatch(/generated code together with the captured outputs of the tools it ran/);
    expect(prompt).toMatch(/each criterion provided in the user message/);
  });

  it("omits the guidance when no tool outputs were captured", () => {
    const prompt = new TestableBundledStrategy("test-model").publicBuildSystemPrompt(false);
    expect(prompt).not.toContain(TOOL_OUTPUTS_GUIDANCE);
  });
});

describe("judge system/user prompt split (criteria + history are user data)", () => {
  // The system prompt must stay invariant across criteria/iterations: it carries
  // only the role, tools, judging method, instructions, and output format. The
  // per-request data — the criterion/criteria and previous-iteration history —
  // belongs in the user prompt.

  describe("BundledStrategy", () => {
    const sys = new TestableBundledStrategy("test-model").publicBuildSystemPrompt(true);

    it("keeps the criteria out of the system prompt", () => {
      expect(sys).not.toContain("## Criteria");
      expect(sys).not.toContain("does the code work");
    });

    it("keeps the previous-iteration history out of the system prompt", () => {
      const sysWithHistoryPath = new TestableBundledStrategy("test-model").publicBuildSystemPrompt(false);
      expect(sys).not.toContain("## Previous Iterations");
      expect(sysWithHistoryPath).not.toContain("## Previous Iterations");
    });

    it("puts the criteria in the user prompt", () => {
      const user = new TestableBundledStrategy("test-model").publicBuildUserPrompt();
      expect(user).toContain("## Criteria");
      expect(user).toContain("c1: does the code work");
    });

    it("appends previous-iteration history to the user prompt only when present", () => {
      const strat = new TestableBundledStrategy("test-model");
      const noHistory = strat.publicBuildUserPrompt();
      expect(noHistory).not.toContain("## Previous Iterations");

      const withHistory = strat.publicBuildUserPrompt(
        [{ id: "c1", prompt: "does the code work" }],
        [
          {
            iteration: 1,
            codingAgentResponse: "did some work",
            judgeFeedback: "needs more",
            passed: false,
          },
        ]
      );
      expect(withHistory).toContain("## Previous Iterations");
      expect(withHistory).toContain("### Iteration 1");
    });
  });

  describe("IndependentStrategy", () => {
    const strat = new TestableStrategy("test-model");
    const sys = strat.publicBuildSystemPrompt(true);

    it("keeps the criterion out of the system prompt", () => {
      expect(sys).not.toContain("**Criterion**");
      expect(sys).toMatch(/the criterion provided in the user message/);
    });

    it("keeps the previous-iteration history out of the system prompt", () => {
      expect(sys).not.toContain("## Previous Iterations");
    });

    it("puts the criterion id and prompt in the user prompt", () => {
      const user = strat.publicBuildUserPrompt({ id: "build-ok", prompt: "it builds" });
      expect(user).toContain('Evaluate criterion "build-ok": it builds');
    });

    it("appends previous-iteration history to the user prompt only when present", () => {
      const noHistory = strat.publicBuildUserPrompt({ id: "build-ok", prompt: "it builds" });
      expect(noHistory).not.toContain("## Previous Iterations");

      const withHistory = strat.publicBuildUserPrompt(
        { id: "build-ok", prompt: "it builds" },
        [{ iteration: 1, codingAgentResponse: "tried", passed: false }]
      );
      expect(withHistory).toContain("## Previous Iterations (for context)");
      expect(withHistory).toContain("### Iteration 1");
    });
  });
});

describe("list_tool_calls page cap via JUDGE_MAX_TOOL_CALLS (issue #1255)", () => {
  // The cap bounds the browse PAGE size only. The canonical deduped list stays
  // whole, so get_tool_output / search_tool_outputs can still reach a one-time
  // action beyond the cap. Here we prove the page is capped but search still finds
  // a call past it.
  const strat = new TestableStrategy("test-model");
  const many = Array.from({ length: 10 }, (_, i) => ({
    id: String(i),
    name: "bash",
    arguments: { command: `cmd-${i}` },
    response: `out-${i}`,
  }));

  it("clamps the returned page to the configured max while keeping the full list searchable", async () => {
    const prev = process.env.JUDGE_MAX_TOOL_CALLS;
    process.env.JUDGE_MAX_TOOL_CALLS = "3";
    try {
      const tools = strat.publicCreateToolOutputTools([{ iteration: 1, toolCalls: many }]);
      const list = tools.find((t) => t.name === "list_tool_calls")!;
      const search = tools.find((t) => t.name === "search_tool_outputs")!;

      const listed: any = await (list.handler as any)({}, stubInvocation);
      expect(listed.totalCalls).toBe(10);
      expect(listed.returnedCalls).toBe(3);
      expect(listed.truncated).toBe(true);

      // A command beyond the page cap is still discoverable via search.
      const found: any = await (search.handler as any)({ pattern: "cmd-9" }, stubInvocation);
      expect(found.matchCount).toBe(1);
      expect(found.matches[0].name).toBe("bash");
    } finally {
      if (prev === undefined) delete process.env.JUDGE_MAX_TOOL_CALLS;
      else process.env.JUDGE_MAX_TOOL_CALLS = prev;
    }
  });

  it("falls back to the default page cap when JUDGE_MAX_TOOL_CALLS is non-numeric", async () => {
    // A non-numeric override must not make the cap NaN (which would collapse the
    // clamp and return an empty page); it should fall back to the default so the
    // captured calls are still listed.
    const prev = process.env.JUDGE_MAX_TOOL_CALLS;
    process.env.JUDGE_MAX_TOOL_CALLS = "not-a-number";
    try {
      const tools = strat.publicCreateToolOutputTools([{ iteration: 1, toolCalls: many }]);
      const list = tools.find((t) => t.name === "list_tool_calls")!;
      const listed: any = await (list.handler as any)({}, stubInvocation);
      expect(listed.totalCalls).toBe(10);
      expect(listed.returnedCalls).toBe(10);
    } finally {
      if (prev === undefined) delete process.env.JUDGE_MAX_TOOL_CALLS;
      else process.env.JUDGE_MAX_TOOL_CALLS = prev;
    }
  });
});

describe("buildPriorResultsSection — structured per-criterion timeline + sticky pass (issue #1255)", () => {
  it("returns empty string when there is no history", () => {
    expect(buildPriorResultsSection([])).toBe("");
  });

  it("renders a PASS/FAIL timeline per criterion from criteriaResults", () => {
    const section = buildPriorResultsSection([
      {
        iteration: 1,
        passed: false,
        criteriaResults: [
          { criterionId: "scaffolds_app", passed: true, feedback: "created via create-app", evaluated: true },
          { criterionId: "has_tests", passed: false, feedback: "no tests yet", evaluated: true },
        ],
      },
      {
        iteration: 2,
        passed: false,
        criteriaResults: [
          { criterionId: "scaffolds_app", passed: false, feedback: "no scaffold command this iteration", evaluated: true },
          { criterionId: "has_tests", passed: true, feedback: "added tests", evaluated: true },
        ],
      },
    ] as any);
    expect(section).toContain("## Prior results from earlier iterations of this run");
    // scaffolds_app oscillated it1 PASS → it2 FAIL — exactly the #1255 trap.
    expect(section).toContain("scaffolds_app: it1 PASS → it2 FAIL");
    expect(section).toContain("has_tests: it1 FAIL → it2 PASS");
    // Includes the most recent feedback for context.
    expect(section).toContain("last feedback (it2)");
  });

  it("includes sticky-pass guidance so a prior PASS isn't re-failed without regression evidence", () => {
    const section = buildPriorResultsSection([
      { iteration: 1, passed: true, criteriaResults: [{ criterionId: "c", passed: true, feedback: "ok", evaluated: true }] },
    ] as any);
    expect(section).toContain(STICKY_PASS_GUIDANCE);
  });

  it("frames sticky pass as strong evidence, NOT a permanent latch (regressions can still fail)", () => {
    const g = STICKY_PASS_GUIDANCE.toLowerCase();
    expect(g).toContain("not a permanent latch");
    expect(g).toMatch(/regress/);
  });

  it("filters the timeline to the given criterion ids (independent strategy path)", () => {
    const section = buildPriorResultsSection(
      [
        {
          iteration: 1,
          passed: false,
          criteriaResults: [
            { criterionId: "a", passed: true, feedback: "", evaluated: true },
            { criterionId: "b", passed: false, feedback: "", evaluated: true },
          ],
        },
      ] as any,
      ["a"]
    );
    expect(section).toContain("a: it1 PASS");
    expect(section).not.toContain("b: it1");
  });

  it("skips criteria that were not evaluated (e.g. descendants of a failed ancestor)", () => {
    const section = buildPriorResultsSection([
      {
        iteration: 1,
        passed: false,
        criteriaResults: [
          { criterionId: "gate", passed: false, feedback: "no", evaluated: true },
          { criterionId: "child", passed: false, feedback: "skipped", evaluated: false },
        ],
      },
    ] as any);
    expect(section).toContain("gate: it1 FAIL");
    expect(section).not.toContain("child");
  });

  it("falls back to prose for older runs without structured criteriaResults", () => {
    const section = buildPriorResultsSection([
      { iteration: 1, passed: false, codingAgentResponse: "tried to build" },
    ] as any);
    expect(section).toContain("## Previous Iterations (for context)");
    expect(section).toContain("### Iteration 1");
    expect(section).not.toContain("## Prior results from earlier iterations");
  });
});
