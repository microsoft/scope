// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CopilotClient, defineTool, SessionEvent } from "@github/copilot-sdk";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, resolve, sep } from "path";
import { execFileSync } from "child_process";
import {
  CriteriaConfig,
  CriterionResult,
  DetailedEvaluationResult,
  ConversationTurn,
  DependencyGraph,
  GateId,
  ToolCall,
  IterationToolCalls,
  TokenManagerClient,
  withRetry,
} from "shared";
import {
  buildToolCallHistory,
  callMatchesIteration,
  stableStringify,
  type FlatToolCall,
  type ToolCallHistory,
} from "./tool-call-history.js";

export interface JudgeStrategyContext {
  workspacePath: string;
  criteria: CriteriaConfig[];
  criteriaGraph: DependencyGraph;
  conversationHistory: ConversationTurn[];
  personaInstructions?: string;
  model?: string;
  /** Called when an individual criterion result is available (for real-time progress) */
  onProgress?: (result: CriterionResult) => void;
  /** Which gate is being evaluated. Defaults to select. */
  gate?: GateId;
  /** The coding agent's captured tool calls/outputs (build/test/run/bootstrap
   *  output) grouped per iteration across the whole run (1..N). Exposed to the
   *  judge via list_tool_calls / search_tool_outputs / get_tool_output. */
  iterationToolCalls?: IterationToolCalls[];
  /** The coding agent's response (prose) for the iteration being judged, exposed via read_agent_response. */
  currentAgentResponse?: string;
}

export function createJudgeCriteriaGraph(
  criteria: CriteriaConfig[],
): DependencyGraph<CriteriaConfig> {
  return new DependencyGraph(criteria);
}

/**
 * Base class for judge evaluation strategies
 */
/** Default timeout for sendAndWait calls (8 minutes) */
const DEFAULT_JUDGE_TIMEOUT = 480_000;

/** Default number of retries for sendAndWait calls */
const DEFAULT_JUDGE_RETRIES = 3;

/**
 * Builds the `## Your Tools` + `## How to Judge` guidance injected into the
 * judge system prompt, listing whichever evidence sources are available for the
 * iteration under evaluation: the workspace files (always), the coding agent's
 * captured tool outputs (when present, via `list_tool_calls` / `search_tool_outputs` / `get_tool_output`),
 * and the coding agent's own response/answer (when present, via
 * `read_agent_response`).
 *
 * The judge runs headless and cannot run any commands itself — it can only
 * inspect the workspace and read what the coding agent already did. This text
 * keeps the judge's own read-only tools unambiguous from the coding agent's
 * tools/commands, and frames every available source as authoritative evidence
 * so the judge bases its decision on actual evidence instead of demanding the
 * agent re-prove work it has already done. It is intentionally generic across
 * all criteria. See scope #1125 (tool outputs) and #1136 (agent response).
 */
export function buildEvidenceGuidance(opts: {
  hasToolOutputs: boolean;
  hasAgentResponse: boolean;
}): string {
  const { hasToolOutputs, hasAgentResponse } = opts;

  let toolsList =
    "read_file, list_directory, search_files and file_exists to inspect the workspace";
  if (hasToolOutputs) {
    toolsList +=
      ", and list_tool_calls / search_tool_outputs / get_tool_output to review the tool calls the coding agent ran across the whole run while doing the task";
  }
  if (hasAgentResponse) {
    toolsList +=
      ", and read_agent_response to read the coding agent's own response (its answer or explanation) for the iteration you are judging";
  }

  const intro =
    hasToolOutputs && hasAgentResponse
      ? "The codebase, the agent's captured tool outputs, and the coding agent's own response are complementary, equally authoritative sources of evidence — examine all of them."
      : hasToolOutputs
        ? "The codebase and the agent's captured tool outputs are two complementary, equally authoritative sources of evidence — examine both."
        : "The codebase and the coding agent's own response are two complementary, equally authoritative sources of evidence — examine both.";

  const toolOutputsPhilosophy = hasToolOutputs
    ? " The files show the resulting state of the code; the captured outputs (logs, results, exit status) show what actually happened when the agent ran a command, which the files alone may not reveal. The captured tool calls span the ENTIRE run (every iteration so far), not just this one — so an action the agent performed once in an earlier iteration (e.g. a bootstrap, scaffold, install, or one-off command) is still recorded and still counts as done now; use search_tool_outputs to find whether a given command ever ran anywhere in the run rather than assuming it didn't because it isn't in the latest iteration. When a criterion concerns something the agent did or ran, take the agent's captured output and exit status as the record of what happened, rather than asking the agent to redo or re-prove work the evidence already shows. If a criterion's wording tells you to run, execute, or re-run a command, ignore that instruction and judge the outcome from the captured outputs together with the codebase."
    : "";

  const agentResponsePhilosophy = hasAgentResponse
    ? " The coding agent's response is the authoritative record of what it said or answered: for any criterion that grades the response itself — answering a question, explaining, advising, or other no-code-change deliverables — read it with read_agent_response and judge that text directly rather than expecting changes in the codebase."
    : "";

  return `## Your Tools
You have read-only tools to gather evidence: ${toolsList}. You yourself cannot run any commands or coding-agent tools — you can only read what the agent already did.

## How to Judge
${intro}${toolOutputsPhilosophy}${agentResponsePhilosophy}`;
}

/**
 * Back-compat constant: the guidance for the common case where only the coding
 * agent's tool outputs (not its response) are available. Equivalent to
 * `buildEvidenceGuidance({ hasToolOutputs: true, hasAgentResponse: false })`.
 */
export const TOOL_OUTPUTS_GUIDANCE = buildEvidenceGuidance({
  hasToolOutputs: true,
  hasAgentResponse: false,
});

/**
 * "Sticky pass" guidance appended to the prior-results section. A criterion that
 * already passed in an earlier iteration should stay satisfied unless there is
 * concrete evidence it regressed — this is what stops a one-time action
 * (bootstrap/scaffold/install) from oscillating PASS↔FAIL and prevents the
 * select gate from never converging. It is deliberately worded as strong
 * evidence, NOT a permanent latch, so genuine regressions can still flip to FAIL.
 */
export const STICKY_PASS_GUIDANCE =
  "A criterion that already PASSED in an earlier iteration of this run should be treated as still satisfied now, UNLESS you find concrete evidence in the current workspace or the captured tool outputs that it regressed. Earlier passes are strong evidence, not a permanent latch — if something genuinely broke, mark it FAIL and say what regressed. Do not re-fail a criterion merely because the action that satisfied it (e.g. a bootstrap, scaffold, install, or one-off command) happened in a previous iteration rather than the latest one; the captured tool history spans the whole run, so use search_tool_outputs to confirm whether that action ever ran.";

/**
 * Builds the "prior results" section of the user prompt from the per-iteration
 * `criteriaResults` already carried in `conversationHistory`. Instead of dumping
 * truncated prose, it renders a compact per-criterion PASS/FAIL timeline plus the
 * most recent feedback, followed by {@link STICKY_PASS_GUIDANCE}. When no turn
 * carries structured `criteriaResults` (older runs), it falls back to a short
 * prose summary. `criterionIds`, when provided, restricts the timeline to those
 * criteria (used by the independent strategy, which judges one criterion at a
 * time); omit it to include every criterion seen (bundled strategy).
 */
export function buildPriorResultsSection(
  conversationHistory: ConversationTurn[],
  criterionIds?: string[]
): string {
  if (!conversationHistory || conversationHistory.length === 0) return "";

  const turns = [...conversationHistory].sort(
    (a, b) => (a.iteration ?? 0) - (b.iteration ?? 0)
  );
  const filter = criterionIds ? new Set(criterionIds) : null;

  const timeline = new Map<
    string,
    { iteration: number; passed: boolean; feedback: string }[]
  >();
  for (const t of turns) {
    const results = t.criteriaResults;
    if (!Array.isArray(results)) continue;
    for (const r of results) {
      if (r.evaluated === false) continue;
      if (filter && !filter.has(r.criterionId)) continue;
      const arr = timeline.get(r.criterionId) ?? [];
      arr.push({
        iteration: t.iteration ?? 0,
        passed: r.passed,
        feedback: r.feedback ?? "",
      });
      timeline.set(r.criterionId, arr);
    }
  }

  if (timeline.size > 0) {
    const FEEDBACK_LIMIT = 300;
    const lines = [...timeline.entries()].map(([cid, entries]) => {
      const seq = entries
        .map((e) => `it${e.iteration} ${e.passed ? "PASS" : "FAIL"}`)
        .join(" → ");
      const last = entries[entries.length - 1];
      const fb = (last.feedback ?? "").replace(/\s+/g, " ").trim();
      const fbLine = fb
        ? `\n    last feedback (it${last.iteration}): "${fb.substring(0, FEEDBACK_LIMIT)}${fb.length > FEEDBACK_LIMIT ? "…" : ""}"`
        : "";
      return `- ${cid}: ${seq}${fbLine}`;
    });
    return `\n\n## Prior results from earlier iterations of this run\n${STICKY_PASS_GUIDANCE}\n\n${lines.join("\n")}`;
  }

  // Fallback for older runs without structured criteriaResults.
  const prose = turns
    .map((t) => {
      const car = t.codingAgentResponse ?? "(no response captured)";
      return `### Iteration ${t.iteration}\n- **Coding agent response**: ${car.substring(0, 400)}${car.length > 400 ? "…" : ""}\n- **Passed**: ${t.passed}`;
    })
    .join("\n\n");
  return `\n\n## Previous Iterations (for context)\n${prose}`;
}

/**
 * Tool filter applied to every judge session.
 *
 * The Copilot SDK's `CopilotClient` defaults to `mode: "copilot-cli"`, which
 * injects the full set of built-in CLI tools (bash, edit, view, ...) into the
 * session alongside the read-only `custom:*` tools we register in
 * `createFileTools`/`createToolOutputTools`. Those built-ins are NOT
 * `skipPermission`, and the judge runs headless (no TUI to answer prompts).
 *
 * The failure mode this guards against: instead of reading the coder's captured
 * output via `list_tool_calls`/`search_tool_outputs`/`get_tool_output`, the judge model decides to
 * "verify" a build/test by running the command itself through the built-in
 * `bash` tool. Headless, that call is denied with "could not request permission
 * from user". The judge then mis-reports this as the coder's result ("execution
 * is blocked by a permission error"), producing a bogus, non-deterministic
 * failure even when the coder's command actually succeeded. See scope #1117.
 *
 * Restricting `availableTools` to `custom:*` (and explicitly excluding
 * `builtin:*`/`mcp:*` as defense in depth, since `excludedTools` always wins)
 * guarantees the model can only ever call our injected, skipPermission tools.
 */
export const JUDGE_AVAILABLE_TOOLS = ["custom:*"] as const;
export const JUDGE_EXCLUDED_TOOLS = ["builtin:*", "mcp:*"] as const;

/**
 * Returns true only if `target` resolves to a path inside (or equal to) the
 * workspace `root`. A plain `startsWith` check is unsafe: `join()` normalizes
 * `..`, so `join("/tmp/ws", "../ws2/x")` → `/tmp/ws2/x`, which shares the
 * `/tmp/ws` prefix and would slip past `startsWith("/tmp/ws")`. We compare the
 * fully-resolved paths and require an exact match or a separator boundary so a
 * sibling like `/tmp/ws2` can never be mistaken for being under `/tmp/ws`.
 * Both tools' handlers rely on this since they are `skipPermission: true` and
 * therefore callable non-interactively by the model.
 */
export function isWithinWorkspace(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(resolvedRoot + sep)
  );
}

export abstract class JudgeStrategy {
  protected model: string;
  protected timeout: number;
  protected maxRetries: number;
  protected tokenClient: TokenManagerClient;

  constructor(model?: string) {
    this.model = model || process.env.JUDGE_MODEL || "gpt-5.4-mini";
    this.timeout = parseInt(process.env.JUDGE_TIMEOUT || String(DEFAULT_JUDGE_TIMEOUT));
    this.maxRetries = parseInt(process.env.JUDGE_RETRIES || String(DEFAULT_JUDGE_RETRIES));
    this.tokenClient = new TokenManagerClient();
    console.log(
      `[judge-strategy] Initialized: model=${this.model}, timeout=${this.timeout}ms, retries=${this.maxRetries}`
    );
  }

  abstract evaluate(
    context: JudgeStrategyContext
  ): Promise<DetailedEvaluationResult>;

  /**
   * Create filesystem inspection tools scoped to the workspace
   */
  protected createFileTools(workspacePath: string) {
    const workspaceRoot = resolve(workspacePath);
    const readFile = defineTool("read_file", {
      description:
        "Read the contents of a file in the workspace. Returns the full text content. Use relative paths from the workspace root.",
      // Read-only, workspace-scoped, traversal-guarded tools must run without a
      // permission prompt: the judge is headless (no TUI), so the v3 runtime
      // would otherwise deny every call with "could not request permission from
      // user", silently breaking all workspace inspection. See scope-doc#64.
      skipPermission: true,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file from the workspace root",
          },
        },
        required: ["path"],
      },
      handler: async (args: { path: string }) => {
        const fullPath = join(workspaceRoot, args.path);
        if (!isWithinWorkspace(workspaceRoot, fullPath)) {
          return { error: "Path traversal not allowed" };
        }
        if (!existsSync(fullPath)) {
          return { error: `File not found: ${args.path}` };
        }
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            return {
              error: `${args.path} is a directory, not a file. Use list_directory instead.`,
            };
          }
          if (stat.size > 100_000) {
            const content = readFileSync(fullPath, "utf-8").substring(
              0,
              100_000
            );
            return { content, truncated: true, totalSize: stat.size };
          }
          const content = readFileSync(fullPath, "utf-8");
          return { content };
        } catch (err) {
          return { error: `Failed to read file: ${err}` };
        }
      },
    });

    const listDirectory = defineTool("list_directory", {
      description:
        "List the contents of a directory in the workspace. Returns file and directory names with their types and sizes.",
      skipPermission: true,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Relative path to the directory from the workspace root. Use '.' for the root directory.",
          },
        },
        required: ["path"],
      },
      handler: async (args: { path: string }) => {
        const fullPath = join(workspaceRoot, args.path);
        if (!isWithinWorkspace(workspaceRoot, fullPath)) {
          return { error: "Path traversal not allowed" };
        }
        if (!existsSync(fullPath)) {
          return { error: `Directory not found: ${args.path}` };
        }
        try {
          const entries = readdirSync(fullPath, { withFileTypes: true });
          const items = entries
            .filter(
              (e) => !e.name.startsWith(".") && e.name !== "node_modules"
            )
            .map((entry) => {
              const entryPath = join(fullPath, entry.name);
              try {
                const stat = statSync(entryPath);
                return {
                  name: entry.name,
                  type: entry.isDirectory() ? "directory" : "file",
                  size: entry.isFile() ? stat.size : undefined,
                };
              } catch {
                return { name: entry.name, type: "unknown" };
              }
            });
          return { path: args.path, entries: items };
        } catch (err) {
          return { error: `Failed to list directory: ${err}` };
        }
      },
    });

    const searchFiles = defineTool("search_files", {
      description:
        "Search for text patterns in files within the workspace using grep. Returns matching lines with file paths and line numbers.",
      skipPermission: true,
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Text pattern or regex to search for",
          },
          path: {
            type: "string",
            description:
              "Relative path to search in. Defaults to '.' (entire workspace).",
          },
          filePattern: {
            type: "string",
            description:
              "Glob pattern to filter files (e.g., '*.ts', '*.py'). Optional.",
          },
        },
        required: ["pattern"],
      },
      handler: async (args: {
        pattern: string;
        path?: string;
        filePattern?: string;
      }) => {
        const searchPath = join(workspaceRoot, args.path || ".");
        if (!isWithinWorkspace(workspaceRoot, searchPath)) {
          return { error: "Path traversal not allowed" };
        }
        try {
          // Run grep without a shell. Passing an argv array (and `-e` before the
          // pattern) means user-controlled values are never interpreted by a
          // shell, eliminating the command-injection surface (e.g. `$(...)`,
          // backticks). This matters because the tool is skipPermission: true.
          let output: string;
          try {
            output = execFileSync(
              "grep",
              [
                "-rn",
                `--include=${args.filePattern || "*"}`,
                "-e",
                args.pattern,
                searchPath,
              ],
              {
                encoding: "utf-8",
                timeout: 10000,
                stdio: ["ignore", "pipe", "ignore"],
                maxBuffer: 10 * 1024 * 1024,
              }
            );
          } catch (err) {
            // grep exits 1 when there are no matches — that's not an error.
            const status = (err as { status?: number }).status;
            if (status === 1) {
              return { matches: [], message: "No matches found" };
            }
            throw err;
          }
          const trimmed = output.trim();
          if (!trimmed) {
            return { matches: [], message: "No matches found" };
          }
          const matches = trimmed
            .split("\n")
            .slice(0, 50)
            .map((line) => line.replace(workspaceRoot + sep, ""));
          return { matches };
        } catch {
          return { matches: [], message: "No matches found or search error" };
        }
      },
    });

    const fileExists = defineTool("file_exists", {
      description: "Check if a file or directory exists in the workspace.",
      skipPermission: true,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to check",
          },
        },
        required: ["path"],
      },
      handler: async (args: { path: string }) => {
        const fullPath = join(workspaceRoot, args.path);
        if (!isWithinWorkspace(workspaceRoot, fullPath)) {
          return { error: "Path traversal not allowed" };
        }
        const exists = existsSync(fullPath);
        let type: string | undefined;
        if (exists) {
          const stat = statSync(fullPath);
          type = stat.isDirectory() ? "directory" : "file";
        }
        return { path: args.path, exists, type };
      },
    });

    return [readFile, listDirectory, searchFiles, fileExists];
  }

  /**
   * Create the tools that expose the coding agent's captured tool calls/outputs
   * across the whole run (iterations 1..N), not just the iteration being judged.
   * Assembled by {@link buildToolCallHistory} into one deduped, chronological,
   * globally-indexed list so a one-time action recorded in an earlier iteration
   * (e.g. a bootstrap/scaffold command) still counts as done when later
   * iterations are judged. See scope #1255.
   *
   * Three tools, in a browse → find → read shape:
   * - `list_tool_calls`   — browse calls across all iterations (deduped,
   *                         filterable by iteration/query, paginated).
   * - `search_tool_outputs` — find a pattern anywhere in the run (scans name +
   *                         arguments + response); the token-cheap way to answer
   *                         "was this command ever run?".
   * - `get_tool_output`   — read one call's full output by its global index.
   */
  protected createToolOutputTools(iterationToolCalls: IterationToolCalls[]) {
    const PREVIEW_LIMIT = 2_000;
    const FULL_LIMIT = 100_000;
    const SNIPPET_RADIUS = 150;
    const DEFAULT_LIST_LIMIT = 50;
    const parsedMaxList = parseInt(process.env.JUDGE_MAX_TOOL_CALLS || "300", 10);
    // A non-numeric override would make MAX_LIST_LIMIT NaN, collapsing the clamp
    // below and returning an empty page; fall back to the default instead.
    const MAX_LIST_LIMIT = Number.isNaN(parsedMaxList) ? 300 : parsedMaxList;
    const DEFAULT_SEARCH_MATCHES = 20;
    const MAX_SEARCH_MATCHES = 100;

    const history: ToolCallHistory = buildToolCallHistory(iterationToolCalls);
    const calls = history.calls;
    const iterationsCovered = history.iterationsCovered;

    const clamp = (n: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, n));

    const previewOf = (call: FlatToolCall) => {
      const response = call.response ?? "";
      const truncated = response.length > PREVIEW_LIMIT || call.responseTruncated;
      return {
        index: call.index,
        iteration: call.iteration,
        ...(call.iterations ? { iterations: call.iterations } : {}),
        ...(call.occurrences ? { occurrences: call.occurrences } : {}),
        name: call.name,
        arguments: call.arguments,
        responsePreview:
          response.length > PREVIEW_LIMIT
            ? response.substring(0, PREVIEW_LIMIT) + "\n…(truncated, use get_tool_output)"
            : response,
        responseTruncated: truncated,
        responseLength: call.responseLength,
      };
    };

    const listToolCalls = defineTool("list_tool_calls", {
      description:
        "List the tool calls the coding agent made across ALL iterations of this run (1..N), e.g. shell/bash commands and their output. The list is deduplicated (identical repeats are collapsed and annotated with `occurrences`/`iterations`) and each entry carries the `iteration` it ran in. Returns each call's global `index`, `name`, `arguments` and a truncated response preview. Optionally filter by `iteration` or a `query` substring over the command name/arguments, and paginate with `limit`/`offset`. Use get_tool_output(index) for a call's full output, or search_tool_outputs to find a specific command anywhere in the run. Consult these to decide whether a command (build, test, run, bootstrap, scaffold) actually succeeded at any point in the run.",
      // Read-only in-memory inspection of already-captured tool calls. Like the
      // file tools, this MUST run without a permission prompt: the judge is
      // headless (no TUI), so the v3 runtime would otherwise deny every call with
      // "could not request permission from user" — which silently blocks the judge
      // from ever seeing the coding agent's build/test output. See scope #1125, #1255.
      skipPermission: true,
      parameters: {
        type: "object",
        properties: {
          iteration: {
            type: "number",
            description: "Only include calls from this iteration number.",
          },
          query: {
            type: "string",
            description: "Only include calls whose name or arguments contain this substring (case-insensitive).",
          },
          limit: {
            type: "number",
            description: `Max calls to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}).`,
          },
          offset: {
            type: "number",
            description: "Number of matching calls to skip, for pagination (default 0).",
          },
        },
        required: [],
      },
      handler: async (args: { iteration?: number; query?: string; limit?: number; offset?: number }) => {
        if (calls.length === 0) {
          return {
            totalCalls: 0,
            calls: [],
            message: "No tool calls were captured for any iteration of this run.",
          };
        }
        const q = args.query?.toLowerCase();
        const filtered = calls.filter((c) => {
          if (args.iteration !== undefined && !callMatchesIteration(c, args.iteration)) {
            return false;
          }
          if (q) {
            const hay = `${c.name}\u0000${stableStringify(c.arguments)}`.toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        });
        const offset = Math.max(0, Math.floor(args.offset ?? 0));
        const limit = clamp(Math.floor(args.limit ?? DEFAULT_LIST_LIMIT), 1, MAX_LIST_LIMIT);
        const page = filtered.slice(offset, offset + limit);
        return {
          totalCalls: calls.length,
          iterationsCovered,
          filteredCalls: filtered.length,
          returnedCalls: page.length,
          offset,
          limit,
          truncated: offset + page.length < filtered.length,
          calls: page.map(previewOf),
        };
      },
    });

    const searchToolOutputs = defineTool("search_tool_outputs", {
      description:
        "Search the coding agent's captured tool calls across ALL iterations of this run for a substring pattern, matching against each call's name, arguments AND response/output. This is the fastest, token-cheapest way to check whether a specific action ever happened in the run — e.g. whether a bootstrap/scaffold command was run, a package installed, a skill or MCP tool invoked, or a specific string appeared in any command's output — without paging through every call. Returns matching calls with their global `index`, `iteration`, and a short snippet around the match; use get_tool_output(index) for the full output.",
      // Read-only; same headless permission rationale as list_tool_calls. See scope #1125, #1255.
      skipPermission: true,
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Substring to search for (case-insensitive), matched against name, arguments and response.",
          },
          iteration: {
            type: "number",
            description: "Restrict the search to this iteration number.",
          },
          maxMatches: {
            type: "number",
            description: `Max matches to return (default ${DEFAULT_SEARCH_MATCHES}, max ${MAX_SEARCH_MATCHES}).`,
          },
        },
        required: ["pattern"],
      },
      handler: async (args: { pattern?: string; iteration?: number; maxMatches?: number }) => {
        const pattern = (args.pattern ?? "").trim();
        if (!pattern) {
          return { error: "pattern is required and must be a non-empty string", matchCount: 0, matches: [] };
        }
        if (calls.length === 0) {
          return {
            matchCount: 0,
            matches: [],
            message: "No tool calls were captured for any iteration of this run.",
          };
        }
        const needle = pattern.toLowerCase();
        const maxMatches = clamp(Math.floor(args.maxMatches ?? DEFAULT_SEARCH_MATCHES), 1, MAX_SEARCH_MATCHES);

        const snippetAround = (text: string, at: number): string => {
          const start = Math.max(0, at - SNIPPET_RADIUS);
          const end = Math.min(text.length, at + needle.length + SNIPPET_RADIUS);
          return (start > 0 ? "…" : "") + text.substring(start, end) + (end < text.length ? "…" : "");
        };

        const matches: Array<{
          index: number;
          iteration: number;
          iterations?: number[];
          occurrences?: number;
          name: string;
          arguments: Record<string, unknown>;
          matchedIn: string;
          snippet: string;
        }> = [];

        for (const c of calls) {
          if (args.iteration !== undefined && !callMatchesIteration(c, args.iteration)) {
            continue;
          }
          const response = c.response ?? "";
          const argsStr = stableStringify(c.arguments);
          const fields: Array<[string, string]> = [
            ["response", response],
            ["name", c.name],
            ["arguments", argsStr],
          ];
          let matchedIn: string | undefined;
          let snippet: string | undefined;
          for (const [field, text] of fields) {
            const at = text.toLowerCase().indexOf(needle);
            if (at !== -1) {
              matchedIn = field;
              snippet = snippetAround(text, at);
              break;
            }
          }
          if (matchedIn && snippet !== undefined) {
            matches.push({
              index: c.index,
              iteration: c.iteration,
              ...(c.iterations ? { iterations: c.iterations } : {}),
              ...(c.occurrences ? { occurrences: c.occurrences } : {}),
              name: c.name,
              arguments: c.arguments,
              matchedIn,
              snippet,
            });
            if (matches.length >= maxMatches) break;
          }
        }

        return {
          pattern,
          matchCount: matches.length,
          truncated: matches.length >= maxMatches,
          matches,
        };
      },
    });

    const getToolOutput = defineTool("get_tool_output", {
      description:
        "Return the full captured output (response) of a single tool call by its global `index`, as listed by list_tool_calls or search_tool_outputs. The result includes the `iteration` the call ran in.",
      // Read-only; same headless permission rationale as list_tool_calls. See scope #1125, #1255.
      skipPermission: true,
      parameters: {
        type: "object",
        properties: {
          index: {
            type: "number",
            description: "Global index of the tool call from list_tool_calls / search_tool_outputs",
          },
        },
        required: ["index"],
      },
      handler: async (args: { index: number }) => {
        const call = calls[args.index];
        if (!call) {
          return { error: `No tool call at index ${args.index} (have ${calls.length})` };
        }
        const response = call.response ?? "";
        const base = {
          index: call.index,
          iteration: call.iteration,
          ...(call.iterations ? { iterations: call.iterations } : {}),
          ...(call.occurrences ? { occurrences: call.occurrences } : {}),
          name: call.name,
          arguments: call.arguments,
        };
        if (response.length > FULL_LIMIT || call.responseTruncated) {
          return {
            ...base,
            response: response.substring(0, FULL_LIMIT),
            truncated: true,
            totalLength: call.responseLength,
          };
        }
        return { ...base, response };
      },
    });

    return [listToolCalls, searchToolOutputs, getToolOutput];
  }

  /**
   * Create the read-only tool that exposes the coding agent's own response
   * (its assistant message / answer) for the iteration being judged. This is
   * the authoritative evidence for criteria that grade what the agent *said*
   * (Q&A, "explain X", advisory / no-code-change tasks), which the workspace
   * files and tool outputs may not contain at all. The response is carried
   * inline in the evaluate request and read in-memory here — no API/blob call.
   * See scope #1136.
   */
  protected createAgentResponseTool(response: string) {
    const FULL_LIMIT = 100_000;

    const readAgentResponse = defineTool("read_agent_response", {
      description:
        "Return the coding agent's own response (its assistant message — answer, explanation, or summary) for the iteration you are judging. This is the authoritative source for any criterion that grades what the agent said, e.g. answering a question, explaining, or advising with no code change — the workspace files and tool outputs may not contain this text at all.",
      // Read-only in-memory read of the response carried in the evaluate
      // request. Must skip the permission prompt for the same headless reason
      // as the file and tool-output tools: the judge has no TUI, so a tool
      // without skipPermission is denied at execution time and the judge could
      // never see the agent's response. See scope #1125, #1136.
      skipPermission: true,
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      handler: async () => {
        if (!response || response.length === 0) {
          return {
            hasResponse: false,
            response: "",
            message: "No agent response was captured for this iteration.",
          };
        }
        if (response.length > FULL_LIMIT) {
          return {
            hasResponse: true,
            response: response.substring(0, FULL_LIMIT),
            truncated: true,
            totalLength: response.length,
          };
        }
        return { hasResponse: true, response, truncated: false, length: response.length };
      },
    });

    return [readAgentResponse];
  }

  /**
   * Run a Copilot session with given prompt and tools, retrying on timeout.
   */
  protected async runCopilotSession(
    workspacePath: string,
    systemPrompt: string,
    userPrompt: string,
    iterationToolCalls?: IterationToolCalls[],
    currentAgentResponse?: string
  ): Promise<string> {
    const hasToolCalls = (iterationToolCalls ?? []).some(
      (g) => g.toolCalls.length > 0
    );
    const tools = [
      ...this.createFileTools(workspacePath),
      ...(hasToolCalls ? this.createToolOutputTools(iterationToolCalls!) : []),
      ...(currentAgentResponse && currentAgentResponse.length > 0
        ? this.createAgentResponseTool(currentAgentResponse)
        : []),
    ];

    return withRetry(
      () => this.doRunCopilotSession(tools, systemPrompt, userPrompt),
      {
        maxRetries: this.maxRetries,
        baseDelayMs: 10_000,
        maxDelayMs: 30_000,
        isRetryable: (error) => {
          const msg = error instanceof Error ? error.message : String(error);
          return (
            msg.includes("timeout") ||
            msg.includes("Timeout") ||
            msg.includes("aborted") ||
            msg.includes("ECONNRESET") ||
            msg.includes("socket hang up")
          );
        },
        onRetry: (error, attempt) => {
          const msg = error instanceof Error ? error.message : String(error);
          console.warn(
            `[judge-strategy] sendAndWait attempt ${attempt} failed (retrying in ≤30s): ${msg.substring(0, 200)}`
          );
        },
      }
    );
  }

  /**
   * Builds the `createSession` config for a judge session. Extracted so the
   * tool-restriction policy (availableTools/excludedTools) is unit-testable
   * without spinning up a real Copilot runtime. See {@link JUDGE_AVAILABLE_TOOLS}.
   */
  protected buildSessionConfig(tools: any[], systemPrompt: string) {
    return {
      model: this.model,
      streaming: true as const,
      tools,
      availableTools: [...JUDGE_AVAILABLE_TOOLS],
      excludedTools: [...JUDGE_EXCLUDED_TOOLS],
      systemMessage: { mode: "replace" as const, content: systemPrompt },
    };
  }

  private async doRunCopilotSession(
    tools: any[],
    systemPrompt: string,
    userPrompt: string
  ): Promise<string> {
    const githubToken = await this.tokenClient.acquireToken("copilot-sdk");
    const client = new CopilotClient({ gitHubToken: githubToken });
    let fullResponse = "";

    try {
      const session = await client.createSession(
        this.buildSessionConfig(tools, systemPrompt) as any
      );

      session.on((event: SessionEvent) => {
        if (event.type === "assistant.message_delta") {
          fullResponse += event.data.deltaContent;
        }
      });

      await session.sendAndWait({ prompt: userPrompt }, this.timeout);
      await client.stop();

      return fullResponse;
    } catch (error) {
      // Ensure client is stopped even on failure
      try { await client.stop(); } catch { /* ignore cleanup errors */ }
      console.error("[judge-strategy] Copilot SDK error:", error);
      throw new Error(
        `Judge evaluation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/**
 * BundledStrategy: Evaluate all criteria in a single session
 *
 * Expects JSON response with per-criterion results:
 * {"results": [{"criterion": "id", "passed": true|false, "feedback": "..."}]}
 */
export class BundledStrategy extends JudgeStrategy {
  async evaluate(
    context: JudgeStrategyContext
  ): Promise<DetailedEvaluationResult> {
    const {
      workspacePath,
      criteria,
      conversationHistory,
      personaInstructions,
      iterationToolCalls,
      currentAgentResponse,
    } = context;

    const hasToolOutputs = (iterationToolCalls ?? []).some(
      (g) => g.toolCalls.length > 0
    );

    const systemPrompt = this.buildSystemPrompt(
      personaInstructions,
      hasToolOutputs,
      !!(currentAgentResponse && currentAgentResponse.length > 0)
    );

    const userPrompt = this.buildUserPrompt(criteria, conversationHistory);

    const response = await this.runCopilotSession(
      workspacePath,
      systemPrompt,
      userPrompt,
      iterationToolCalls,
      currentAgentResponse
    );

    return this.parseJsonResponse(response, criteria, context.onProgress);
  }

  /**
   * Builds the invariant system prompt (role, persona, tools, judging method,
   * instructions, output format). It does NOT contain the criteria or the
   * previous-iteration history — those are per-request data carried by the user
   * prompt (see {@link buildUserPrompt}) so the system prompt stays identical
   * across every criterion and iteration in a run.
   */
  private buildSystemPrompt(
    personaInstructions?: string,
    hasToolOutputs?: boolean,
    hasAgentResponse?: boolean
  ): string {
    const personaSection = personaInstructions
      ? `\n## Persona\n${personaInstructions}\n`
      : "";

    const evidenceSection = (hasToolOutputs || hasAgentResponse)
      ? `\n${buildEvidenceGuidance({
          hasToolOutputs: !!hasToolOutputs,
          hasAgentResponse: !!hasAgentResponse,
        })}\n`
      : "";

    return `You are an expert code reviewer evaluating the tool calls, logs and generated code produced by a coding agent.
${personaSection}
## What to Evaluate
Evaluate whether the coding agent's work — its generated code together with the captured outputs of the tools it ran — meets each criterion provided in the user message.
${evidenceSection}
## Instructions
1. Gather evidence from every available source.
2. Evaluate EACH criterion individually.
3. For each criterion, provide specific feedback about what you found.
4. Be constructive and actionable in your feedback.

## Output Format
Your response MUST be valid JSON with this structure:
\`\`\`json
{
  "results": [
    {"criterion": "criterion-id", "passed": true, "feedback": "Brief explanation of what was found"},
    {"criterion": "criterion-id", "passed": false, "feedback": "Specific explanation of what's missing"}
  ]
}
\`\`\`

IMPORTANT: Return ONLY the JSON, no additional text before or after.`;
  }

  /**
   * Builds the per-request user prompt: the criteria to evaluate plus any
   * previous-iteration context. This is the data the (invariant) system prompt
   * refers to.
   */
  private buildUserPrompt(
    criteria: CriteriaConfig[],
    conversationHistory: ConversationTurn[]
  ): string {
    const criteriaList = criteria
      .map((c) => `  - ${c.id}: ${c.prompt}`)
      .join("\n");

    const historySection = buildPriorResultsSection(
      conversationHistory,
      criteria.map((c) => c.id)
    );

    return `Evaluate the workspace against ALL criteria below. Use the file tools to inspect the code, then provide your verdict in JSON format.

## Criteria
${criteriaList}${historySection}`;
  }

  private parseJsonResponse(
    response: string,
    criteria: CriteriaConfig[],
    onProgress?: (result: CriterionResult) => void,
  ): DetailedEvaluationResult {
    // Try to extract JSON from markdown code blocks
    let jsonStr = response.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    } else {
      // Try to find raw JSON
      const rawJsonMatch = jsonStr.match(/(\{[\s\S]*\})/);
      if (rawJsonMatch) {
        jsonStr = rawJsonMatch[1];
      }
    }

    try {
      const data = JSON.parse(jsonStr);
      if (!data.results || !Array.isArray(data.results)) {
        throw new Error("Invalid JSON structure: missing results array");
      }

      const results: CriterionResult[] = [];
      const evaluatedIds = new Set<string>();

      for (const item of data.results) {
        const result: CriterionResult = {
          criterionId: item.criterion || "unknown",
          passed: item.passed === true,
          feedback: item.feedback || "",
          evaluated: true,
        };
        results.push(result);
        evaluatedIds.add(item.criterion);
        onProgress?.(result);
      }

      // Add any missing criteria as not evaluated
      for (const criterion of criteria) {
        if (!evaluatedIds.has(criterion.id)) {
          const result: CriterionResult = {
            criterionId: criterion.id,
            passed: false,
            feedback: "Not evaluated",
            evaluated: false,
          };
          results.push(result);
          onProgress?.(result);
        }
      }

      const allPassed = results.every((r) => r.passed);

      return {
        allPassed,
        results,
        evaluatedIds,
        strategy: "bundled",
      };
    } catch (error) {
      console.error("[BundledStrategy] Failed to parse JSON:", error);
      console.error("[BundledStrategy] Response was:", response);

      // Fallback: treat all as not passed
      const results: CriterionResult[] = criteria.map((c) => ({
        criterionId: c.id,
        passed: false,
        feedback: `Failed to parse judge response: ${response.substring(0, 200)}`,
        evaluated: false,
      }));

      return {
        allPassed: false,
        results,
        evaluatedIds: new Set(),
        strategy: "bundled",
      };
    }
  }
}

/**
 * IndependentStrategy: Evaluate criteria separately in topological order
 *
 * - Evaluates ready criteria in parallel (up to maxParallelism)
 * - Skips descendants of failed criteria
 * - Each criterion gets its own session with PASS/FAIL response
 */
export class IndependentStrategy extends JudgeStrategy {
  private maxParallelism: number;

  constructor(model?: string, maxParallelism: number = 3) {
    super(model);
    this.maxParallelism = maxParallelism;
  }

  async evaluate(
    context: JudgeStrategyContext
  ): Promise<DetailedEvaluationResult> {
    const {
      workspacePath,
      criteria,
      criteriaGraph,
      conversationHistory,
      personaInstructions,
      onProgress,
      gate,
      iterationToolCalls,
      currentAgentResponse,
    } = context;

    // Get topological order
    const topoOrder = criteriaGraph.topologicalSort();
    const criteriaIds = new Set(criteria.map((c) => c.id));
    const criteriaById = new Map(criteria.map((c) => [c.id, c]));

    // Track state
    const results: CriterionResult[] = [];
    const failedIds = new Set<string>();
    const evaluatedIds = new Set<string>();
    let pending = new Set(criteriaIds);

    let evalIndex = 0;

    // Process in waves
    while (pending.size > 0) {
      // Find ready and skipped criteria
      const ready: string[] = [];
      const toSkip: string[] = [];

      for (const cid of Array.from(pending)) {
        const ancestors = criteriaGraph.getAncestors(cid);
        const ancestorsInSet = new Set(
          Array.from(ancestors).filter((a) => criteriaIds.has(a))
        );

        // Check if any ancestor failed
        const hasFailedAncestor = Array.from(ancestorsInSet).some((a) =>
          failedIds.has(a)
        );

        if (hasFailedAncestor) {
          toSkip.push(cid);
        } else if (
          Array.from(ancestorsInSet).every((a) => evaluatedIds.has(a))
        ) {
          ready.push(cid);
        }
      }

      // Skip criteria with failed ancestors
      for (const cid of toSkip) {
        const result: CriterionResult = {
          criterionId: cid,
          passed: false,
          feedback: "Skipped: ancestor criterion failed",
          evaluated: false,
        };
        results.push(result);
        pending.delete(cid);
        onProgress?.(result);
      }

      // Evaluate ready batch in parallel
      if (ready.length > 0) {
        const batch = ready.slice(0, this.maxParallelism);
        const promises = batch.map((cid) =>
          this.evaluateSingleCriterion(
            workspacePath,
            criteriaById.get(cid)!,
            conversationHistory,
            personaInstructions,
            evalIndex++,
            gate,
            iterationToolCalls,
            currentAgentResponse
          )
        );

        const batchResults = await Promise.all(promises);

        for (const result of batchResults) {
          results.push(result);
          evaluatedIds.add(result.criterionId);
          if (!result.passed) {
            failedIds.add(result.criterionId);
          }
          pending.delete(result.criterionId);
          onProgress?.(result);
        }
      } else if (toSkip.length === 0) {
        // No ready and no skipped - shouldn't happen but break to prevent infinite loop
        console.warn(
          "[IndependentStrategy] No ready or skipped criteria, breaking loop"
        );
        break;
      }
    }

    const allPassed = results.every((r) => r.passed);

    return {
      allPassed,
      results,
      evaluatedIds,
      strategy: "independent",
    };
  }

  private async evaluateSingleCriterion(
    workspacePath: string,
    criterion: CriteriaConfig,
    conversationHistory: ConversationTurn[],
    personaInstructions: string | undefined,
    index: number,
    gate?: GateId,
    iterationToolCalls?: IterationToolCalls[],
    currentAgentResponse?: string
  ): Promise<CriterionResult> {
    const hasToolOutputs = (iterationToolCalls ?? []).some(
      (g) => g.toolCalls.length > 0
    );

    const systemPrompt = this.buildSystemPrompt(
      personaInstructions,
      hasToolOutputs,
      !!(currentAgentResponse && currentAgentResponse.length > 0)
    );

    const userPrompt = this.buildUserPrompt(criterion, conversationHistory);

    try {
      const response = await this.runCopilotSession(
        workspacePath,
        systemPrompt,
        userPrompt,
        iterationToolCalls,
        currentAgentResponse
      );

      const passed = this.detectPassFail(response);
      const feedback = response
        .trim()
        .replace(/^(PASS|FAIL):\s*/i, "")
        .trim();

      return {
        criterionId: criterion.id,
        passed,
        feedback,
        evaluated: true,
      };
    } catch (error) {
      return {
        criterionId: criterion.id,
        passed: false,
        feedback: `Evaluation error: ${error instanceof Error ? error.message : String(error)}`,
        evaluated: false,
      };
    }
  }

  /**
   * Builds the invariant system prompt (role, persona, tools, judging method,
   * instructions, output format). It does NOT contain the criterion or the
   * previous-iteration history — those are per-request data carried by the user
   * prompt (see {@link buildUserPrompt}) so the system prompt stays identical
   * across every criterion and iteration in a run.
   */
  protected buildSystemPrompt(
    personaInstructions?: string,
    hasToolOutputs?: boolean,
    hasAgentResponse?: boolean
  ): string {
    const personaSection = personaInstructions
      ? `\n## Persona\n${personaInstructions}\n`
      : "";

    const evidenceSection = (hasToolOutputs || hasAgentResponse)
      ? `\n${buildEvidenceGuidance({
          hasToolOutputs: !!hasToolOutputs,
          hasAgentResponse: !!hasAgentResponse,
        })}\n`
      : "";

    return `You are an expert code reviewer evaluating the tool calls, logs and generated code produced by a coding agent against ONE specific criterion.
${personaSection}
## What to Evaluate
Evaluate the coding agent's work — its generated code together with the captured outputs of the tools it ran — against the criterion provided in the user message.
${evidenceSection}
## Instructions
1. Gather evidence from every available source.
2. Determine if the criterion is met (PASS) or not met (FAIL).
3. Provide specific feedback about what you found.

## Output Format
**CRITICAL**: The FIRST LINE of your response MUST be exactly "PASS:" or "FAIL:" (nothing else on that line).
Then provide your explanation on subsequent lines.

Example:
PASS:
The workspace contains a package.json file with express listed as a dependency (version 4.18.0).

Or:
FAIL:
No package.json file was found in the workspace root.`;
  }

  /**
   * Builds the per-request user prompt: the single criterion to evaluate plus
   * any previous-iteration context. This is the data the (invariant) system
   * prompt refers to.
   */
  protected buildUserPrompt(
    criterion: CriteriaConfig,
    conversationHistory: ConversationTurn[]
  ): string {
    const historySection = buildPriorResultsSection(conversationHistory, [
      criterion.id,
    ]);

    return `Evaluate criterion "${criterion.id}": ${criterion.prompt}${historySection}`;
  }

  private detectPassFail(response: string): boolean {
    const lines = response.trim().split("\n");
    const firstLines = lines.slice(0, 3).join("\n").toUpperCase();

    // Look for PASS or FAIL patterns (with optional markdown formatting)
    const passMatch = firstLines.match(
      /(?:^|\*\*|##\s*)\s*PASS\s*(?:\*\*)?:?/
    );
    const failMatch = firstLines.match(
      /(?:^|\*\*|##\s*)\s*FAIL\s*(?:\*\*)?:?/
    );

    if (passMatch && failMatch) {
      // Both found - whichever comes first wins
      return passMatch.index! < failMatch.index!;
    }

    if (passMatch) {
      return true;
    }

    // Default to fail if no clear signal
    return false;
  }
}

/**
 * Factory function to create a judge strategy
 */
export function createJudgeStrategy(
  type: "bundled" | "independent",
  config?: { model?: string; maxParallelism?: number }
): JudgeStrategy {
  if (type === "independent") {
    return new IndependentStrategy(config?.model, config?.maxParallelism);
  }
  return new BundledStrategy(config?.model);
}
