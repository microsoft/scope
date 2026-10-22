// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Source-agnostic model of the coding agent's captured trajectory, plus the
 * read-only judge tools that expose it. Issue #1156 / scope #1125.
 *
 * The judge is fed the agent's work through one of two channels that are really
 * the SAME thing captured at different fidelities:
 *
 *   - GATES send the HAR-extracted `ToolCall[]` (build/test/run output) via
 *     `toolCallsUrl` → normalized here by {@link fromToolCalls}.
 *   - OBSERVATIONS (#1156) send the full ATIF trajectory via `atifUrl` → the
 *     normalized superset, parsed here by {@link fromAtif}. The ATIF additionally
 *     carries the agent's **tool definitions** (the catalog of tools it had
 *     available) and per-step reasoning.
 *
 * Both normalize into ONE in-memory {@link AgentTrajectory}, over which we expose
 * ONE unified tool set ({@link createTrajectoryTools}) — two symmetric pairs:
 *   - DEFINITIONS — `list_agent_tools` / `get_agent_tools` (what tools existed).
 *   - CALLS — `list_agent_tool_calls` / `get_agent_tool_calls` (what the agent did).
 *
 * This REPLACES the previous opaque "stuff the 86 KB ATIF into one synthetic tool
 * call" hack (apps/judge/src/index.ts) whose 2 000-char preview buried the actual
 * tool calls under the ~26 KB system prompt, causing non-deterministic false
 * negatives on trajectory-only observations (e.g. `dependency_added_then_removed`).
 *
 * Large outputs are spilled to a caller-provided directory OUTSIDE the workspace
 * so they never pollute the codebase other criteria inspect; the judge reads them
 * back with its existing `read_file` (which is granted that dir as an extra root).
 */
import { defineTool } from "@github/copilot-sdk";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { ToolCall } from "shared";

/** Max chars of a tool-call response (or tool-definition description) returned
 * inline by `get_agent_tool_calls` / `get_agent_tools`. Above this the full text
 * is written to the spill dir and returned as a file path instead. */
export const INLINE_LIMIT = 16_000;

/** Chars of the response/description retained as an at-a-glance preview. */
export const PREVIEW_LIMIT = 500;

/** Chars of the per-call preview surfaced by the list/triage tools. */
export const LIST_PREVIEW_LIMIT = 200;

/** One captured invocation the agent made (normalized across HAR and ATIF). */
export interface AgentToolCall {
  /** Stable id — the ATIF `tool_call_id` or HAR `ToolCall.id` (synthesized if absent). */
  toolCallId: string;
  /** 1-based ATIF step the call was made in (undefined for the HAR/gate path). */
  step?: number;
  /** Tool/function name (e.g. `bash`, `create`, `edit`). */
  name: string;
  /** One-line digest of the arguments for triage. */
  summary: string;
  /** Raw arguments the agent passed. */
  arguments: Record<string, unknown>;
  /** Captured output/result text. */
  response: string;
  /** First {@link PREVIEW_LIMIT} chars of {@link response}. */
  responsePreview: string;
  /** Full length of {@link response} in chars. */
  responseLength: number;
  /** Step-level reasoning that preceded the call (ATIF only). */
  reasoning?: string;
}

/** One entry from the agent's tool catalog (ATIF `agent.tool_definitions`). */
export interface AgentToolDefinition {
  /** Tool name — the identifier callers pass to `get_agent_tools`. */
  name: string;
  /** Tool type (usually `"function"`). */
  type: string;
  /** Human-readable description the agent was given. */
  description?: string;
  /** JSON-schema of the tool's parameters. */
  parameters?: Record<string, unknown>;
}

/** Lightweight overview of one ATIF step (never the raw system-prompt text). */
export interface StepOverview {
  step: number;
  source: string;
  toolCallCount: number;
  reasoningSummary?: string;
}

/** Normalized, source-agnostic view of the agent's captured trajectory. */
export interface AgentTrajectory {
  source: "tool-calls" | "atif";
  agent?: string;
  model?: string;
  calls: AgentToolCall[];
  /** Index of {@link calls} by {@link AgentToolCall.toolCallId}. */
  byId: Map<string, AgentToolCall>;
  /** The agent's tool catalog (ATIF only; empty for the HAR/gate path). */
  toolDefinitions: AgentToolDefinition[];
  /** Index of {@link toolDefinitions} by {@link AgentToolDefinition.name}. */
  toolDefsByName: Map<string, AgentToolDefinition>;
  /** Per-step overview (ATIF only). */
  steps?: StepOverview[];
  /** ATIF `final_metrics`, passed through opaquely. */
  finalMetrics?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** First `limit` chars of `text`, with an ellipsis marker when truncated. */
export function previewOf(text: string, limit: number = PREVIEW_LIMIT): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "…";
}

/** Coerce any value to a readable string (ATIF content can be string|object). */
function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Coerce ATIF observation/message content (string | ContentPart[]) into text.
 * ContentPart is `{ type: "text"|"image", text?, source? }`; we keep the text
 * parts and note image parts.
 */
function coerceContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object") {
          const p = part as { type?: string; text?: string };
          if (typeof p.text === "string") return p.text;
          if (p.type === "image") return "[image]";
        }
        return asText(part);
      })
      .join("");
  }
  return asText(content);
}

/** One-line digest of a call's arguments for triage in the list tools. */
export function summarizeArgs(name: string, args: Record<string, unknown>): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  if (typeof a.command === "string") return a.command.slice(0, 200);
  if (typeof a.path === "string") return a.path;
  if (typeof a.file === "string") return a.file;
  if (typeof a.pattern === "string") return `pattern: ${a.pattern}`;
  if (typeof a.url === "string") return a.url;
  if (typeof a.summary === "string") return a.summary.slice(0, 200);
  const json = asText(a);
  return json.length > 120 ? json.slice(0, 120) + "…" : json;
}

/** Filesystem-safe spill filename derived from an id + its position. */
export function safeId(id: string, index: number): string {
  const slug = (id || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return `${slug || "call"}-${index}`;
}

function buildById(calls: AgentToolCall[]): Map<string, AgentToolCall> {
  const byId = new Map<string, AgentToolCall>();
  for (const call of calls) {
    // First write wins; later collisions are unreachable in practice because
    // ids are unique (synthesized ids embed the position).
    if (!byId.has(call.toolCallId)) byId.set(call.toolCallId, call);
  }
  return byId;
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

/**
 * Normalize the HAR-extracted tool calls (the gate path) into an
 * {@link AgentTrajectory}. HAR carries no tool catalog or reasoning, so
 * `toolDefinitions`/`steps` are empty.
 */
export function fromToolCalls(toolCalls: ToolCall[] | undefined): AgentTrajectory {
  const list = Array.isArray(toolCalls) ? toolCalls : [];
  const calls: AgentToolCall[] = list.map((tc, i) => {
    const response = asText(tc.response ?? "");
    const args = (tc.arguments ?? {}) as Record<string, unknown>;
    const name = tc.name ?? "unknown";
    return {
      toolCallId: tc.id || `call-${i}`,
      name,
      summary: summarizeArgs(name, args),
      arguments: args,
      response,
      responsePreview: previewOf(response),
      responseLength: response.length,
    };
  });
  return {
    source: "tool-calls",
    calls,
    byId: buildById(calls),
    toolDefinitions: [],
    toolDefsByName: new Map(),
  };
}

interface AtifContentPart {
  type?: string;
  text?: string;
}
interface AtifToolCall {
  tool_call_id?: string;
  function_name?: string;
  arguments?: Record<string, unknown>;
}
interface AtifObservationResult {
  source_call_id?: string;
  content?: string | AtifContentPart[];
}
interface AtifStep {
  step_id?: number;
  source?: string;
  model_name?: string;
  reasoning_content?: string;
  tool_calls?: AtifToolCall[];
  observation?: { results?: AtifObservationResult[] };
}
interface AtifToolDefinition {
  type?: string;
  function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
}
interface AtifTrajectory {
  agent?: {
    name?: string;
    version?: string;
    model_name?: string;
    tool_definitions?: AtifToolDefinition[];
  };
  steps?: AtifStep[];
  final_metrics?: unknown;
}

/** Parse the raw ATIF blob defensively into an object (handles string input and
 * an optional `{ trajectory: … }` wrapper). Returns `{}` on any failure. */
function parseAtif(input: unknown): AtifTrajectory {
  let obj: unknown = input;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object") return {};
  const maybeWrapped = obj as { trajectory?: unknown };
  if (maybeWrapped.trajectory && typeof maybeWrapped.trajectory === "object") {
    return maybeWrapped.trajectory as AtifTrajectory;
  }
  return obj as AtifTrajectory;
}

/**
 * Normalize a parsed ATIF trajectory (the observation path) into an
 * {@link AgentTrajectory}. Walks the steps: agent steps contribute their
 * `tool_calls[]`, each paired with the matching same-step
 * `observation.results[]` by `source_call_id === tool_call_id`. System and user
 * steps are summarized in `steps` but never contribute calls (and their raw
 * message text — including the large system prompt — is never surfaced).
 */
export function fromAtif(input: unknown): AgentTrajectory {
  const traj = parseAtif(input);
  const agent = traj.agent ?? {};
  const stepsArr = Array.isArray(traj.steps) ? traj.steps : [];

  const calls: AgentToolCall[] = [];
  const steps: StepOverview[] = [];
  let synth = 0;
  let firstAgentModel: string | undefined;

  for (let i = 0; i < stepsArr.length; i++) {
    const step = stepsArr[i] ?? {};
    const stepNum = typeof step.step_id === "number" ? step.step_id : i + 1;
    const source = typeof step.source === "string" ? step.source : "unknown";
    const reasoning =
      typeof step.reasoning_content === "string" && step.reasoning_content.length > 0
        ? step.reasoning_content
        : undefined;
    const stepCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];

    if (source === "agent" && !firstAgentModel && typeof step.model_name === "string") {
      firstAgentModel = step.model_name;
    }

    // Index this step's observation results by the call they answer.
    const obsByCallId = new Map<string, string>();
    const results = step.observation?.results;
    if (Array.isArray(results)) {
      for (const r of results) {
        if (r && typeof r.source_call_id === "string") {
          obsByCallId.set(r.source_call_id, coerceContent(r.content));
        }
      }
    }

    for (const tc of stepCalls) {
      const name = typeof tc.function_name === "string" ? tc.function_name : "unknown";
      const args = (tc.arguments ?? {}) as Record<string, unknown>;
      const toolCallId =
        typeof tc.tool_call_id === "string" && tc.tool_call_id.length > 0
          ? tc.tool_call_id
          : `atif-${stepNum}-${synth++}`;
      const response = obsByCallId.get(toolCallId) ?? "";
      calls.push({
        toolCallId,
        step: stepNum,
        name,
        summary: summarizeArgs(name, args),
        arguments: args,
        response,
        responsePreview: previewOf(response),
        responseLength: response.length,
        reasoning,
      });
    }

    steps.push({
      step: stepNum,
      source,
      toolCallCount: stepCalls.length,
      reasoningSummary: reasoning ? previewOf(reasoning, LIST_PREVIEW_LIMIT) : undefined,
    });
  }

  const defs = Array.isArray(agent.tool_definitions) ? agent.tool_definitions : [];
  const toolDefinitions: AgentToolDefinition[] = defs
    .map((d) => ({
      name: d?.function?.name ?? "",
      type: typeof d?.type === "string" ? d.type : "function",
      description: d?.function?.description,
      parameters: d?.function?.parameters,
    }))
    .filter((d) => d.name.length > 0);
  const toolDefsByName = new Map(toolDefinitions.map((d) => [d.name, d]));

  return {
    source: "atif",
    agent: typeof agent.name === "string" ? agent.name : undefined,
    model: agent.model_name ?? firstAgentModel,
    calls,
    byId: buildById(calls),
    toolDefinitions,
    toolDefsByName,
    steps,
    finalMetrics: traj.final_metrics,
  };
}

/**
 * Merge several {@link AgentTrajectory}s (e.g. one per iteration) into a single
 * whole-run trajectory for `subject:"run"` observation evaluation (#1156).
 *
 * - `calls` are concatenated in iteration order. Colliding `toolCallId`s (the
 *   ATIF synthesizes step-local ids like `atif-3-0` that restart each iteration)
 *   are re-keyed `it<n>:<id>` so every call stays addressable via
 *   `get_agent_tool_calls`.
 * - `toolDefinitions` are unioned by name (first wins).
 * - `steps` are concatenated, each tagged with its source iteration.
 *
 * A list of length 0 yields an empty trajectory; length 1 is returned as-is.
 */
export function mergeTrajectories(list: AgentTrajectory[]): AgentTrajectory {
  const items = (list ?? []).filter((t): t is AgentTrajectory => Boolean(t));
  if (items.length === 0) {
    return {
      source: "atif",
      calls: [],
      byId: new Map(),
      toolDefinitions: [],
      toolDefsByName: new Map(),
    };
  }
  if (items.length === 1) return items[0];

  const calls: AgentToolCall[] = [];
  const seen = new Set<string>();
  items.forEach((traj, t) => {
    for (const call of traj.calls) {
      let uid = call.toolCallId;
      if (seen.has(uid)) {
        uid = `it${t + 1}:${call.toolCallId}`;
        let k = 1;
        while (seen.has(uid)) uid = `it${t + 1}:${call.toolCallId}-${k++}`;
      }
      seen.add(uid);
      calls.push(uid === call.toolCallId ? call : { ...call, toolCallId: uid });
    }
  });

  const toolDefinitions: AgentToolDefinition[] = [];
  const toolDefsByName = new Map<string, AgentToolDefinition>();
  for (const traj of items) {
    for (const def of traj.toolDefinitions) {
      if (!toolDefsByName.has(def.name)) {
        toolDefsByName.set(def.name, def);
        toolDefinitions.push(def);
      }
    }
  }

  const steps: StepOverview[] = [];
  items.forEach((traj, t) => {
    for (const s of traj.steps ?? []) {
      steps.push({ ...s, source: `it${t + 1}:${s.source}` });
    }
  });

  const first = items[0];
  const anyAtif = items.some((x) => x.source === "atif");
  return {
    source: anyAtif ? "atif" : "tool-calls",
    agent: first.agent,
    model: first.model,
    calls,
    byId: buildById(calls),
    toolDefinitions,
    toolDefsByName,
    steps: steps.length > 0 ? steps : undefined,
    finalMetrics: items[items.length - 1]?.finalMetrics,
  };
}

/**
 * Normalize a list of raw ATIF payloads (one per iteration) into a single
 * merged whole-run {@link AgentTrajectory}. Convenience over
 * {@link mergeTrajectories} ∘ {@link fromAtif}.
 */
export function fromAtifList(inputs: unknown[]): AgentTrajectory {
  return mergeTrajectories((inputs ?? []).map((x) => fromAtif(x)));
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function writeSpill(spillDir: string, filename: string, text: string): string {
  mkdirSync(spillDir, { recursive: true });
  const file = join(spillDir, `${filename}.txt`);
  writeFileSync(file, text, "utf-8");
  return file;
}

/**
 * Build the four read-only trajectory tools over a normalized
 * {@link AgentTrajectory}. All are `skipPermission: true` because the judge runs
 * headless (no TUI to answer permission prompts; see scope #1125).
 *
 * @param trajectory normalized agent trajectory
 * @param spillDir directory OUTSIDE the workspace where oversized outputs are
 *   written so they never pollute the codebase under evaluation. The judge reads
 *   them back via `read_file` (which is granted this dir as an extra read root).
 */
export function createTrajectoryTools(trajectory: AgentTrajectory, spillDir: string) {
  const listAgentTools = defineTool("list_agent_tools", {
    description:
      "List the tools the coding agent had available during this run (its tool catalog / definitions). Returns each tool's name, type, a short description preview and whether it takes parameters. Use get_agent_tools(toolNames) to fetch a tool's full description and parameter schema. Empty when no tool catalog was captured.",
    skipPermission: true,
    parameters: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const tools = trajectory.toolDefinitions.map((d) => {
        const description = d.description ?? "";
        return {
          name: d.name,
          type: d.type,
          descriptionPreview: previewOf(description, LIST_PREVIEW_LIMIT),
          descriptionLength: description.length,
          hasParameters: !!d.parameters && Object.keys(d.parameters).length > 0,
        };
      });
      return { count: tools.length, tools };
    },
  });

  const getAgentTools = defineTool("get_agent_tools", {
    description:
      "Return the full definition (type, description and parameter JSON-schema) of the named agent tools, as listed by list_agent_tools. Pass a list of tool names. A very long description is written to a file (descriptionFile) you can open with read_file; the parameter schema is always returned inline. Unknown names are returned in notFound.",
    skipPermission: true,
    parameters: {
      type: "object",
      properties: {
        toolNames: {
          type: "array",
          items: { type: "string" },
          description: "Tool names to fetch (from list_agent_tools).",
        },
      },
      required: ["toolNames"],
    },
    handler: async (args: { toolNames?: string[] }) => {
      const names = Array.isArray(args?.toolNames) ? args.toolNames : [];
      const tools: Record<string, unknown>[] = [];
      const notFound: string[] = [];
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const def = trajectory.toolDefsByName.get(name);
        if (!def) {
          notFound.push(name);
          continue;
        }
        const description = def.description ?? "";
        const base: Record<string, unknown> = {
          name: def.name,
          type: def.type,
          parameters: def.parameters,
          descriptionLength: description.length,
        };
        if (description.length <= INLINE_LIMIT) {
          base.description = description;
        } else {
          base.descriptionPreview = previewOf(description);
          base.descriptionFile = writeSpill(spillDir, safeId(`tool-${def.name}`, i), description);
        }
        tools.push(base);
      }
      return { tools, notFound };
    },
  });

  const listAgentToolCalls = defineTool("list_agent_tool_calls", {
    description:
      "List the tool calls the coding agent made during this run (its trajectory of invocations). Returns each call's toolCallId, step, name, a one-line argument summary, a short response preview and the full response length. Use get_agent_tool_calls(toolCallIds) to fetch full arguments and output for the calls you care about. Consult these to determine what the agent actually did and whether a command succeeded.",
    skipPermission: true,
    parameters: { type: "object", properties: {}, required: [] },
    handler: async () => {
      if (trajectory.calls.length === 0) {
        return { count: 0, calls: [], message: "No tool calls were captured for this run." };
      }
      const calls = trajectory.calls.map((c) => ({
        toolCallId: c.toolCallId,
        step: c.step,
        name: c.name,
        summary: c.summary,
        responsePreview: c.responsePreview.slice(0, LIST_PREVIEW_LIMIT),
        responseLength: c.responseLength,
      }));
      return { count: calls.length, calls };
    },
  });

  const getAgentToolCalls = defineTool("get_agent_tool_calls", {
    description:
      "Return the full arguments and captured output for a list of tool calls, identified by their toolCallId (as listed by list_agent_tool_calls). A very long output is written to a file (responseFile) you can open with read_file; shorter outputs are returned inline. Unknown ids are returned in notFound.",
    skipPermission: true,
    parameters: {
      type: "object",
      properties: {
        toolCallIds: {
          type: "array",
          items: { type: "string" },
          description: "Tool call ids to fetch (from list_agent_tool_calls).",
        },
      },
      required: ["toolCallIds"],
    },
    handler: async (args: { toolCallIds?: string[] }) => {
      const ids = Array.isArray(args?.toolCallIds) ? args.toolCallIds : [];
      const calls: Record<string, unknown>[] = [];
      const notFound: string[] = [];
      for (const id of ids) {
        const c = trajectory.byId.get(id);
        if (!c) {
          notFound.push(id);
          continue;
        }
        const base: Record<string, unknown> = {
          toolCallId: c.toolCallId,
          step: c.step,
          name: c.name,
          arguments: c.arguments,
          reasoning: c.reasoning,
          responseLength: c.responseLength,
        };
        if (c.responseLength <= INLINE_LIMIT) {
          base.response = c.response;
        } else {
          const pos = trajectory.calls.indexOf(c);
          base.responsePreview = c.responsePreview;
          base.responseFile = writeSpill(spillDir, safeId(c.toolCallId, pos), c.response);
        }
        calls.push(base);
      }
      return { calls, notFound };
    },
  });

  const getTrajectoryOverview = defineTool("get_trajectory_overview", {
    description:
      "Return a high-level overview of the agent's run: source, agent, model, the number of available tools and tool calls, a per-step summary (without the raw system prompt) and final metrics. Use this to orient before drilling into specific tools or calls.",
    skipPermission: true,
    parameters: { type: "object", properties: {}, required: [] },
    handler: async () => ({
      source: trajectory.source,
      agent: trajectory.agent,
      model: trajectory.model,
      totalTools: trajectory.toolDefinitions.length,
      totalCalls: trajectory.calls.length,
      steps: trajectory.steps,
      finalMetrics: trajectory.finalMetrics,
    }),
  });

  return [
    listAgentTools,
    getAgentTools,
    listAgentToolCalls,
    getAgentToolCalls,
    getTrajectoryOverview,
  ];
}
