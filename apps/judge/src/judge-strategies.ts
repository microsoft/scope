// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CopilotClient, defineTool, SessionEvent } from "@github/copilot-sdk";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { CriteriaConfig, CriterionResult, DetailedEvaluationResult, ConversationTurn } from "@scope/core";
import { DependencyGraph } from "@scope/criteria";
import { TokenManagerClient } from "@scope/secrets";

export interface JudgeStrategyContext {
  workspacePath: string;
  criteria: CriteriaConfig[];
  criteriaGraph: DependencyGraph;
  conversationHistory: ConversationTurn[];
  personaInstructions?: string;
  model?: string;
  /** Called when an individual criterion result is available (for real-time progress) */
  onProgress?: (result: CriterionResult) => void;
}

/**
 * Base class for judge evaluation strategies
 */
/** Default timeout for sendAndWait calls (5 minutes) */
const DEFAULT_JUDGE_TIMEOUT = 300_000;

export abstract class JudgeStrategy {
  protected model: string;
  protected timeout: number;
  protected tokenClient: TokenManagerClient;

  constructor(model?: string) {
    this.model = model || process.env.JUDGE_MODEL || "gpt-4.1";
    this.timeout = parseInt(process.env.JUDGE_TIMEOUT || String(DEFAULT_JUDGE_TIMEOUT));
    this.tokenClient = new TokenManagerClient();
  }

  abstract evaluate(
    context: JudgeStrategyContext
  ): Promise<DetailedEvaluationResult>;

  /**
   * Create filesystem inspection tools scoped to the workspace
   */
  protected createFileTools(workspacePath: string) {
    const readFile = defineTool("read_file", {
      description:
        "Read the contents of a file in the workspace. Returns the full text content. Use relative paths from the workspace root.",
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
        const fullPath = join(workspacePath, args.path);
        if (!fullPath.startsWith(workspacePath)) {
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
        const fullPath = join(workspacePath, args.path);
        if (!fullPath.startsWith(workspacePath)) {
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
        const searchPath = join(workspacePath, args.path || ".");
        if (!searchPath.startsWith(workspacePath)) {
          return { error: "Path traversal not allowed" };
        }
        try {
          let cmd = `grep -rn --include='${args.filePattern || "*"}' "${args.pattern.replace(/"/g, '\\"')}" "${searchPath}" 2>/dev/null | head -50`;
          const output = execSync(cmd, {
            encoding: "utf-8",
            timeout: 10000,
          }).trim();
          if (!output) {
            return { matches: [], message: "No matches found" };
          }
          const matches = output.split("\n").map((line) => {
            const relLine = line.replace(workspacePath + "/", "");
            return relLine;
          });
          return { matches };
        } catch {
          return { matches: [], message: "No matches found or search error" };
        }
      },
    });

    const fileExists = defineTool("file_exists", {
      description: "Check if a file or directory exists in the workspace.",
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
        const fullPath = join(workspacePath, args.path);
        if (!fullPath.startsWith(workspacePath)) {
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
   * Run a Copilot session with given prompt and tools
   */
  protected async runCopilotSession(
    workspacePath: string,
    systemPrompt: string,
    userPrompt: string
  ): Promise<string> {
    const tools = this.createFileTools(workspacePath);
    const githubToken = await this.tokenClient.acquireToken("copilot-sdk");
    const client = new CopilotClient({ githubToken });
    let fullResponse = "";

    try {
      const session = await client.createSession({
        model: this.model,
        streaming: true,
        tools,
        systemMessage: { mode: "replace", content: systemPrompt },
      });

      session.on((event: SessionEvent) => {
        if (event.type === "assistant.message_delta") {
          fullResponse += event.data.deltaContent;
        }
      });

      await session.sendAndWait({ prompt: userPrompt }, this.timeout);
      await client.stop();

      return fullResponse;
    } catch (error) {
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
    } = context;

    const systemPrompt = this.buildSystemPrompt(
      criteria,
      conversationHistory,
      personaInstructions
    );

    const response = await this.runCopilotSession(
      workspacePath,
      systemPrompt,
      "Evaluate the workspace against ALL criteria. Use the file tools to inspect the code, then provide your verdict in JSON format."
    );

    return this.parseJsonResponse(response, criteria, context.onProgress);
  }

  private buildSystemPrompt(
    criteria: CriteriaConfig[],
    conversationHistory: ConversationTurn[],
    personaInstructions?: string
  ): string {
    const criteriaList = criteria
      .map((c) => `  - ${c.id}: ${c.prompt}`)
      .join("\n");

    const historySection =
      conversationHistory.length > 0
        ? `\n## Previous Iterations\n${conversationHistory
            .map((t) => {
              const car = t.codingAgentResponse ?? "(no response captured)";
              const fb = t.judgeFeedback;
              return `### Iteration ${t.iteration}\n- **Coding agent response**: ${car.substring(0, 500)}${car.length > 500 ? "..." : ""}\n- **Your previous feedback**: ${fb.substring(0, 500)}${fb.length > 500 ? "..." : ""}\n- **Passed**: ${t.passed}`;
            })
            .join("\n\n")}`
        : "";

    const personaSection = personaInstructions
      ? `\n## Persona\n${personaInstructions}\n`
      : "";

    return `You are an expert code reviewer evaluating whether generated code meets requirements.
${personaSection}
## Your Task
Inspect the workspace using the provided tools (read_file, list_directory, search_files, file_exists) and evaluate whether the code meets each criterion.

## Criteria
${criteriaList}
${historySection}

## Instructions
1. Use the tools to thoroughly inspect the workspace.
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
            evalIndex++
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
    index: number
  ): Promise<CriterionResult> {
    const historySection =
      conversationHistory.length > 0
        ? `\n## Previous Iterations (for context)\n${conversationHistory
            .map((t) => {
              const car = t.codingAgentResponse ?? "(no response captured)";
              return `### Iteration ${t.iteration}\n- **Coding agent response**: ${car.substring(0, 300)}${car.length > 300 ? "..." : ""}\n- **Passed**: ${t.passed}`;
            })
            .join("\n\n")}`
        : "";

    const personaSection = personaInstructions
      ? `\n## Persona\n${personaInstructions}\n`
      : "";

    const systemPrompt = `You are an expert code reviewer evaluating ONE specific criterion.
${personaSection}
## Your Task
Inspect the workspace using the provided tools and evaluate ONLY this criterion:

**Criterion**: ${criterion.prompt}

${historySection}

## Instructions
1. Use the file tools to thoroughly inspect the workspace.
2. Determine if this specific criterion is met (PASS) or not met (FAIL).
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

    try {
      const response = await this.runCopilotSession(
        workspacePath,
        systemPrompt,
        `Evaluate criterion "${criterion.id}": ${criterion.prompt}`
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
