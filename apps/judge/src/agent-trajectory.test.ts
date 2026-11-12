// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Unit tests for the source-agnostic agent-trajectory model (issue #1156, P10).
 *
 * Covers both normalizers (`fromAtif` for the observation/ATIF path, `fromToolCalls`
 * for the gate/HAR path), the five unified navigation tools, the out-of-workspace
 * spill behaviour for oversized outputs, and the strict-superset contract that the
 * new tools expose everything the removed `read_tool_outputs`/`get_tool_output`
 * pair did.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, sep } from "path";
import type { ToolCall } from "shared";
import {
  fromAtif,
  fromAtifList,
  fromToolCalls,
  mergeTrajectories,
  createTrajectoryTools,
  summarizeArgs,
  safeId,
  previewOf,
  INLINE_LIMIT,
  type AgentTrajectory,
} from "./agent-trajectory.js";

const stubInvocation = {
  sessionId: "test-session",
  toolCallId: "test-call",
  toolName: "test-tool",
  arguments: {},
};

/** Invoke a trajectory tool's handler by name. */
async function call(
  tools: ReturnType<typeof createTrajectoryTools>,
  name: string,
  args: Record<string, unknown> = {}
): Promise<any> {
  const tool = tools.find((t) => t.name === name);
  if (!tool?.handler) throw new Error(`tool ${name} not found`);
  return (tool.handler as (a: unknown, b: unknown) => unknown)(args, stubInvocation);
}

/**
 * Realistic ATIF blob: system + user step, then agent steps that install,
 * use, and uninstall `left-pad`. Mirrors the real ATIF shape pp-taxonomy
 * downloads (steps carry their own tool_calls AND the matching
 * observation.results, paired by source_call_id === tool_call_id).
 */
const REALISTIC_ATIF = {
  schema_version: "atif/1",
  session_id: "fixture",
  agent: {
    name: "copilot",
    version: "1.0.0",
    model_name: "claude-opus-4.6",
    tool_definitions: [
      {
        type: "function",
        function: {
          name: "bash",
          description: "Run a shell command.",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      },
      {
        type: "function",
        function: { name: "view", description: "View a file.", parameters: { type: "object" } },
      },
      {
        type: "function",
        function: { name: "edit", description: "Edit a file." },
      },
      // Nameless definition — must be dropped.
      { type: "function", function: { description: "no name" } },
    ],
  },
  steps: [
    { step_id: 1, source: "system" },
    { step_id: 2, source: "user" },
    {
      step_id: 3,
      source: "agent",
      model_name: "claude-opus-4.6",
      reasoning_content: "Add left-pad.",
      tool_calls: [{ tool_call_id: "call-1", function_name: "bash", arguments: { command: "npm install left-pad" } }],
      observation: { results: [{ source_call_id: "call-1", content: "added 1 package\n+ left-pad@1.3.0" }] },
    },
    {
      step_id: 4,
      source: "agent",
      tool_calls: [{ tool_call_id: "call-2", function_name: "edit", arguments: { path: "index.js" } }],
      // ContentPart[] form of observation content.
      observation: {
        results: [
          { source_call_id: "call-2", content: [{ type: "text", text: "edited " }, { type: "text", text: "index.js" }] },
        ],
      },
    },
    {
      step_id: 5,
      source: "agent",
      reasoning_content: "Remove left-pad.",
      tool_calls: [{ tool_call_id: "call-3", function_name: "bash", arguments: { command: "npm uninstall left-pad" } }],
      observation: { results: [{ source_call_id: "call-3", content: "removed 1 package" }] },
    },
  ],
  final_metrics: { steps: 5 },
};

describe("fromAtif", () => {
  const traj = fromAtif(REALISTIC_ATIF);

  it("flattens only agent tool calls, keyed by tool_call_id", () => {
    expect(traj.source).toBe("atif");
    expect(traj.calls.map((c) => c.toolCallId)).toEqual(["call-1", "call-2", "call-3"]);
    expect(traj.byId.get("call-1")!.name).toBe("bash");
    expect(traj.byId.get("call-1")!.summary).toBe("npm install left-pad");
  });

  it("excludes system/user steps from calls but records them in steps overview", () => {
    expect(traj.steps?.map((s) => s.source)).toEqual(["system", "user", "agent", "agent", "agent"]);
    // No call carries the system prompt text.
    expect(traj.calls.every((c) => c.step && c.step >= 3)).toBe(true);
  });

  it("matches each call's response from the same-step observation result", () => {
    expect(traj.byId.get("call-1")!.response).toContain("left-pad@1.3.0");
    expect(traj.byId.get("call-3")!.response).toBe("removed 1 package");
  });

  it("coerces ContentPart[] observation content into joined text", () => {
    expect(traj.byId.get("call-2")!.response).toBe("edited index.js");
  });

  it("captures per-step reasoning on the calls", () => {
    expect(traj.byId.get("call-1")!.reasoning).toBe("Add left-pad.");
    expect(traj.byId.get("call-3")!.reasoning).toBe("Remove left-pad.");
  });

  it("reads agent + model metadata", () => {
    expect(traj.agent).toBe("copilot");
    expect(traj.model).toBe("claude-opus-4.6");
    expect(traj.finalMetrics).toEqual({ steps: 5 });
  });

  it("populates tool definitions from agent.tool_definitions, dropping nameless ones", () => {
    expect(traj.toolDefinitions.map((d) => d.name)).toEqual(["bash", "view", "edit"]);
    expect(traj.toolDefsByName.get("bash")!.description).toBe("Run a shell command.");
  });

  it("parses a JSON string input", () => {
    const fromString = fromAtif(JSON.stringify(REALISTIC_ATIF));
    expect(fromString.calls.map((c) => c.toolCallId)).toEqual(["call-1", "call-2", "call-3"]);
  });

  it("unwraps a { trajectory: … } wrapper", () => {
    const wrapped = fromAtif({ trajectory: REALISTIC_ATIF });
    expect(wrapped.calls).toHaveLength(3);
  });

  it("returns an empty trajectory for garbage / empty input", () => {
    expect(fromAtif("not json").calls).toEqual([]);
    expect(fromAtif(null).calls).toEqual([]);
    expect(fromAtif({}).calls).toEqual([]);
    expect(fromAtif(42).calls).toEqual([]);
  });

  it("synthesizes an id for a tool call missing tool_call_id", () => {
    const traj2 = fromAtif({
      steps: [
        {
          step_id: 7,
          source: "agent",
          tool_calls: [{ function_name: "bash", arguments: { command: "ls" } }],
        },
      ],
    });
    expect(traj2.calls).toHaveLength(1);
    expect(traj2.calls[0].toolCallId).toBe("atif-7-0");
  });
});

describe("fromToolCalls (HAR / gate path)", () => {
  const harCalls: ToolCall[] = [
    { id: "h1", name: "bash", arguments: { command: "npm run build" }, response: "build ok", timestamp: "" },
    { id: "h2", name: "view", arguments: { path: "server.js" }, response: "file contents", timestamp: "" },
  ];
  const traj = fromToolCalls(harCalls);

  it("maps each HAR ToolCall to an AgentToolCall keyed by id", () => {
    expect(traj.source).toBe("tool-calls");
    expect(traj.calls.map((c) => c.toolCallId)).toEqual(["h1", "h2"]);
    expect(traj.byId.get("h1")!.response).toBe("build ok");
    expect(traj.byId.get("h1")!.summary).toBe("npm run build");
  });

  it("has no tool catalog (HAR carries no definitions)", () => {
    expect(traj.toolDefinitions).toEqual([]);
    expect(traj.steps).toBeUndefined();
  });

  it("synthesizes positional ids when a HAR call has none", () => {
    const t = fromToolCalls([{ id: "", name: "bash", arguments: {}, response: "x", timestamp: "" }]);
    expect(t.calls[0].toolCallId).toBe("call-0");
  });

  it("handles undefined input", () => {
    expect(fromToolCalls(undefined).calls).toEqual([]);
  });
});

describe("createTrajectoryTools — calls pair (list/get)", () => {
  let spillRoot: string;
  const traj = fromAtif(REALISTIC_ATIF);

  beforeAll(() => {
    spillRoot = mkdtempSync(join(tmpdir(), "traj-spill-"));
  });
  afterAll(() => rmSync(spillRoot, { recursive: true, force: true }));

  it("list_agent_tool_calls returns a triage index of every call", async () => {
    const tools = createTrajectoryTools(traj, spillRoot);
    const res = await call(tools, "list_agent_tool_calls");
    expect(res.count).toBe(3);
    expect(res.calls.map((c: any) => c.toolCallId)).toEqual(["call-1", "call-2", "call-3"]);
    expect(res.calls[0]).toMatchObject({ name: "bash", step: 3, summary: "npm install left-pad" });
    expect(res.calls[0].responseLength).toBeGreaterThan(0);
  });

  it("get_agent_tool_calls returns full details for requested ids and reports notFound", async () => {
    const tools = createTrajectoryTools(traj, spillRoot);
    const res = await call(tools, "get_agent_tool_calls", { toolCallIds: ["call-1", "nope"] });
    expect(res.notFound).toEqual(["nope"]);
    expect(res.calls).toHaveLength(1);
    expect(res.calls[0]).toMatchObject({
      toolCallId: "call-1",
      name: "bash",
      arguments: { command: "npm install left-pad" },
      reasoning: "Add left-pad.",
    });
    expect(res.calls[0].response).toContain("left-pad@1.3.0");
  });

  it("empty trajectory → list returns count 0 with a message", async () => {
    const tools = createTrajectoryTools(fromAtif({}), spillRoot);
    const res = await call(tools, "list_agent_tool_calls");
    expect(res).toMatchObject({ count: 0, calls: [] });
    expect(res.message).toBeTruthy();
  });
});

describe("createTrajectoryTools — oversized output spills OUTSIDE the workspace", () => {
  let parent: string;
  let workspace: string;
  let spillDir: string;
  const bigOutput = "X".repeat(INLINE_LIMIT + 5000);

  // A trajectory whose single call has an output larger than INLINE_LIMIT.
  const bigTraj: AgentTrajectory = fromAtif({
    steps: [
      {
        step_id: 3,
        source: "agent",
        tool_calls: [{ tool_call_id: "big-1", function_name: "bash", arguments: { command: "cat huge.log" } }],
        observation: { results: [{ source_call_id: "big-1", content: bigOutput }] },
      },
    ],
  });

  beforeAll(() => {
    parent = mkdtempSync(join(tmpdir(), "traj-ws-parent-"));
    workspace = join(parent, "workspace");
    spillDir = join(parent, "spill");
    mkdirSync(workspace, { recursive: true });
  });
  afterAll(() => rmSync(parent, { recursive: true, force: true }));

  it("writes the full output to a spill file outside the workspace and omits the inline response", async () => {
    const tools = createTrajectoryTools(bigTraj, spillDir);
    const res = await call(tools, "get_agent_tool_calls", { toolCallIds: ["big-1"] });
    const one = res.calls[0];

    // No inline blob — only a preview + a file pointer.
    expect(one.response).toBeUndefined();
    expect(one.responsePreview).toBeTruthy();
    expect(one.responseLength).toBe(bigOutput.length);

    // The spill file is real, holds the FULL output, and lives OUTSIDE the workspace.
    expect(typeof one.responseFile).toBe("string");
    expect(existsSync(one.responseFile)).toBe(true);
    expect(readFileSync(one.responseFile, "utf-8")).toBe(bigOutput);
    expect(one.responseFile.startsWith(workspace + sep)).toBe(false);
    expect(one.responseFile.startsWith(spillDir)).toBe(true);
  });

  it("keeps a small output inline (no spill file)", async () => {
    const smallTraj = fromAtif({
      steps: [
        {
          step_id: 3,
          source: "agent",
          tool_calls: [{ tool_call_id: "s1", function_name: "bash", arguments: { command: "echo hi" } }],
          observation: { results: [{ source_call_id: "s1", content: "hi" }] },
        },
      ],
    });
    const tools = createTrajectoryTools(smallTraj, spillDir);
    const res = await call(tools, "get_agent_tool_calls", { toolCallIds: ["s1"] });
    expect(res.calls[0].response).toBe("hi");
    expect(res.calls[0].responseFile).toBeUndefined();
  });
});

describe("createTrajectoryTools — definitions pair (list/get)", () => {
  let spillDir: string;
  const traj = fromAtif(REALISTIC_ATIF);

  beforeAll(() => {
    spillDir = mkdtempSync(join(tmpdir(), "traj-defs-"));
  });
  afterAll(() => rmSync(spillDir, { recursive: true, force: true }));

  it("list_agent_tools returns the agent's tool catalog", async () => {
    const tools = createTrajectoryTools(traj, spillDir);
    const res = await call(tools, "list_agent_tools");
    expect(res.count).toBe(3);
    expect(res.tools.map((t: any) => t.name)).toEqual(["bash", "view", "edit"]);
    const bash = res.tools.find((t: any) => t.name === "bash");
    expect(bash).toMatchObject({ type: "function", hasParameters: true });
    expect(bash.descriptionLength).toBeGreaterThan(0);
  });

  it("get_agent_tools returns full definition + parameters and reports notFound", async () => {
    const tools = createTrajectoryTools(traj, spillDir);
    const res = await call(tools, "get_agent_tools", { toolNames: ["bash", "ghost"] });
    expect(res.notFound).toEqual(["ghost"]);
    expect(res.tools).toHaveLength(1);
    expect(res.tools[0]).toMatchObject({
      name: "bash",
      type: "function",
      description: "Run a shell command.",
    });
    expect(res.tools[0].parameters).toMatchObject({ type: "object" });
  });

  it("on the HAR/gate path the catalog is empty (count 0)", async () => {
    const tools = createTrajectoryTools(fromToolCalls([]), spillDir);
    const res = await call(tools, "list_agent_tools");
    expect(res).toMatchObject({ count: 0, tools: [] });
  });

  it("spills a very long tool description to a descriptionFile outside the workspace", async () => {
    const bigDesc = "D".repeat(INLINE_LIMIT + 1000);
    const t = fromAtif({
      agent: { tool_definitions: [{ type: "function", function: { name: "huge", description: bigDesc } }] },
      steps: [],
    });
    const tools = createTrajectoryTools(t, spillDir);
    const res = await call(tools, "get_agent_tools", { toolNames: ["huge"] });
    const def = res.tools[0];
    expect(def.description).toBeUndefined();
    expect(def.descriptionPreview).toBeTruthy();
    expect(existsSync(def.descriptionFile)).toBe(true);
    expect(readFileSync(def.descriptionFile, "utf-8")).toBe(bigDesc);
  });
});

describe("get_trajectory_overview", () => {
  it("summarizes the run without the system-prompt blob", async () => {
    const spillDir = mkdtempSync(join(tmpdir(), "traj-ov-"));
    try {
      const tools = createTrajectoryTools(fromAtif(REALISTIC_ATIF), spillDir);
      const res = await call(tools, "get_trajectory_overview");
      expect(res).toMatchObject({
        source: "atif",
        agent: "copilot",
        model: "claude-opus-4.6",
        totalTools: 3,
        totalCalls: 3,
      });
      expect(res.steps).toHaveLength(5);
    } finally {
      rmSync(spillDir, { recursive: true, force: true });
    }
  });
});

describe("strict-superset contract over the HAR path (replaces read_tool_outputs/get_tool_output)", () => {
  // The new tools must expose everything the removed pair did: list every call,
  // and return each call's FULL response — for large outputs via a spill file
  // whose content equals the full response.
  let spillDir: string;
  const bigResponse = "Z".repeat(INLINE_LIMIT + 2000);
  const harCalls: ToolCall[] = [
    { id: "g1", name: "bash", arguments: { command: "npm run build" }, response: "build succeeded", timestamp: "" },
    { id: "g2", name: "bash", arguments: { command: "npm test" }, response: bigResponse, timestamp: "" },
  ];

  beforeAll(() => {
    spillDir = mkdtempSync(join(tmpdir(), "traj-super-"));
  });
  afterAll(() => rmSync(spillDir, { recursive: true, force: true }));

  it("list_agent_tool_calls lists every HAR call (same count + names as read_tool_outputs)", async () => {
    const tools = createTrajectoryTools(fromToolCalls(harCalls), spillDir);
    const res = await call(tools, "list_agent_tool_calls");
    expect(res.count).toBe(2);
    expect(res.calls.map((c: any) => `${c.toolCallId}:${c.name}`)).toEqual(["g1:bash", "g2:bash"]);
  });

  it("get_agent_tool_calls returns the same full response get_tool_output would (small inline)", async () => {
    const tools = createTrajectoryTools(fromToolCalls(harCalls), spillDir);
    const res = await call(tools, "get_agent_tool_calls", { toolCallIds: ["g1"] });
    expect(res.calls[0].response).toBe("build succeeded");
  });

  it("a large HAR response is spilled and the file content equals the full response", async () => {
    const tools = createTrajectoryTools(fromToolCalls(harCalls), spillDir);
    const res = await call(tools, "get_agent_tool_calls", { toolCallIds: ["g2"] });
    expect(res.calls[0].response).toBeUndefined();
    expect(readFileSync(res.calls[0].responseFile, "utf-8")).toBe(bigResponse);
  });
});

describe("helpers", () => {
  it("summarizeArgs prefers command, then path/file, then pattern/url/summary, else JSON", () => {
    expect(summarizeArgs("bash", { command: "ls -la" })).toBe("ls -la");
    expect(summarizeArgs("view", { path: "a/b.ts" })).toBe("a/b.ts");
    expect(summarizeArgs("search", { pattern: "TODO" })).toBe("pattern: TODO");
    expect(summarizeArgs("x", { foo: 1 })).toContain("foo");
  });

  it("safeId slugifies the id and appends the index", () => {
    expect(safeId("call/with:weird*chars", 3)).toBe("call_with_weird_chars-3");
    expect(safeId("", 0)).toBe("call-0");
  });

  it("previewOf truncates with an ellipsis marker", () => {
    expect(previewOf("abcdef", 3)).toBe("abc…");
    expect(previewOf("abc", 10)).toBe("abc");
  });
});

describe("mergeTrajectories / fromAtifList (run-subject whole-run path #1156)", () => {
  it("returns an empty trajectory for an empty list", () => {
    const merged = mergeTrajectories([]);
    expect(merged.calls).toEqual([]);
    expect(merged.toolDefinitions).toEqual([]);
    expect(merged.byId.size).toBe(0);
  });

  it("returns the single trajectory unchanged for a length-1 list", () => {
    const only = fromAtif(REALISTIC_ATIF);
    expect(mergeTrajectories([only])).toBe(only);
  });

  it("concatenates calls in iteration order and preserves both iterations' work", () => {
    const it1 = fromToolCalls([
      { id: "a", name: "bash", arguments: { command: "npm install left-pad" }, response: "added 1 package", timestamp: "" },
    ]);
    const it2 = fromToolCalls([
      { id: "b", name: "bash", arguments: { command: "npm uninstall left-pad" }, response: "removed 1 package", timestamp: "" },
    ]);
    const merged = mergeTrajectories([it1, it2]);
    expect(merged.calls.map((c) => c.toolCallId)).toEqual(["a", "b"]);
    expect(merged.calls[0].response).toContain("added");
    expect(merged.calls[1].response).toContain("removed");
    // Both addressable by id.
    expect(merged.byId.get("a")?.summary).toBe("npm install left-pad");
    expect(merged.byId.get("b")?.summary).toBe("npm uninstall left-pad");
  });

  it("re-keys colliding tool-call ids so every call stays addressable", () => {
    const it1 = fromToolCalls([{ id: "dup", name: "bash", arguments: { command: "first" }, response: "r1", timestamp: "" }]);
    const it2 = fromToolCalls([{ id: "dup", name: "bash", arguments: { command: "second" }, response: "r2", timestamp: "" }]);
    const merged = mergeTrajectories([it1, it2]);
    expect(merged.calls).toHaveLength(2);
    const ids = merged.calls.map((c) => c.toolCallId);
    expect(ids[0]).toBe("dup");
    expect(ids[1]).toBe("it2:dup");
    expect(new Set(ids).size).toBe(2);
    expect(merged.byId.get("dup")?.summary).toBe("first");
    expect(merged.byId.get("it2:dup")?.summary).toBe("second");
  });

  it("unions tool definitions by name (first wins)", () => {
    const a = fromAtif(REALISTIC_ATIF); // has a populated catalog
    const b = fromAtif(REALISTIC_ATIF);
    const merged = mergeTrajectories([a, b]);
    // Deduplicated, not doubled.
    expect(merged.toolDefinitions.length).toBe(a.toolDefinitions.length);
    expect(merged.toolDefsByName.size).toBe(a.toolDefsByName.size);
  });

  it("tags merged step overviews with their source iteration", () => {
    const merged = mergeTrajectories([fromAtif(REALISTIC_ATIF), fromAtif(REALISTIC_ATIF)]);
    expect(merged.steps?.some((s) => s.source.startsWith("it1:"))).toBe(true);
    expect(merged.steps?.some((s) => s.source.startsWith("it2:"))).toBe(true);
  });

  it("fromAtifList normalizes + merges raw ATIF payloads", () => {
    const merged = fromAtifList([REALISTIC_ATIF, REALISTIC_ATIF]);
    expect(merged.source).toBe("atif");
    // Twice the agent calls of a single ATIF.
    const single = fromAtif(REALISTIC_ATIF);
    expect(merged.calls.length).toBe(single.calls.length * 2);
  });

  it("merged trajectory is navigable via createTrajectoryTools across iterations", async () => {
    const it1 = fromToolCalls([{ id: "x", name: "bash", arguments: { command: "npm install left-pad" }, response: "added", timestamp: "" }]);
    const it2 = fromToolCalls([{ id: "y", name: "bash", arguments: { command: "npm uninstall left-pad" }, response: "removed", timestamp: "" }]);
    const spillDir = mkdtempSync(join(tmpdir(), "judge-merge-spill-"));
    try {
      const tools = createTrajectoryTools(mergeTrajectories([it1, it2]), spillDir);
      const res = await call(tools, "list_agent_tool_calls");
      expect(res.count).toBe(2);
      expect(res.calls.map((c: any) => c.toolCallId)).toEqual(["x", "y"]);
    } finally {
      rmSync(spillDir, { recursive: true, force: true });
    }
  });
});
