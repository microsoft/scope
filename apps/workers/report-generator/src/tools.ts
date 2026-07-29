// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineTool } from "@github/copilot-sdk";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import type { RequestDocument } from "@scope/core";

/**
 * Create tools for the report agent to access run data via the REST API
 * and inspect workspace snapshots extracted to a local temp directory.
 */
export function createReportTools(
  apiBaseUrl: string,
  requestId: string,
  snapshotsDir: string,
  reportId: string
) {
  const getRunSummary = defineTool("get_run_summary", {
    description:
      "Get the summary of the benchmark run including scenario, worker type, persona, status, iteration count, and criteria list.",
    parameters: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/v1/requests/${requestId}`);
        if (!response.ok) {
          return { error: `Failed to fetch run: ${response.status} ${response.statusText}` };
        }
        const request: RequestDocument = await response.json();
        const run = request.run;
        return {
          id: request._id,
          task: request.scenario?.task,
          criteria: request.scenario?.criteria,
          workerType: request.workerType,
          status: run?.status,
          outcome: run?.outcome,
          persona: request.persona,
          personaInstructions: request.personaInstructions,
          maxIterations: request.maxIterations,
          turnCount: run?.turns?.length || 0,
          createdAt: request.createdAt,
          updatedAt: request.updatedAt,
          error: run?.error,
        };
      } catch (err) {
        return { error: `Failed to fetch run summary: ${err}` };
      }
    },
  });

  const listTurns = defineTool("list_turns", {
    description:
      "List all turns in the run with their iteration number, pass/fail status, and criteria results summary.",
    parameters: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/v1/requests/${requestId}`);
        if (!response.ok) {
          return { error: `Failed to fetch run: ${response.status} ${response.statusText}` };
        }
        const request: RequestDocument = await response.json();
        const run = request.run;
        const turns = (run?.turns || []).map((turn: any) => ({
          iteration: turn.iteration,
          passed: turn.passed,
          timestamp: turn.timestamp,
          startedAt: turn.startedAt,
          durationMs: turn.durationMs,
          criteriaResults: (turn.criteriaResults || []).map((cr: any) => ({
            criterionId: cr.criterionId,
            passed: cr.passed,
            evaluated: cr.evaluated,
          })),
          hasSnapshot: !!turn.snapshotUrl,
        }));
        return { turns, total: turns.length };
      } catch (err) {
        return { error: `Failed to list turns: ${err}` };
      }
    },
  });

  const getTurnDetail = defineTool("get_turn_detail", {
    description:
      "Get full details for a specific turn including the coding agent's response, judge feedback, and per-criterion results with feedback.",
    parameters: {
      type: "object",
      properties: {
        iteration: {
          type: "number",
          description: "The iteration number (1-based) of the turn to inspect.",
        },
      },
      required: ["iteration"],
    },
    handler: async (args: { iteration: number }) => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/v1/requests/${requestId}`);
        if (!response.ok) {
          return { error: `Failed to fetch run: ${response.status} ${response.statusText}` };
        }
        const request: RequestDocument = await response.json();
        const run = request.run;
        const turn = (run?.turns || []).find((t: any) => t.iteration === args.iteration);
        if (!turn) {
          return { error: `Turn ${args.iteration} not found` };
        }
        return {
          iteration: turn.iteration,
          passed: turn.passed,
          timestamp: turn.timestamp,
          startedAt: turn.startedAt,
          durationMs: turn.durationMs,
          codingAgentResponse: turn.codingAgentResponse,
          judgeFeedback: turn.judgeFeedback,
          criteriaResults: turn.criteriaResults || [],
          hasSnapshot: !!turn.snapshotUrl,
        };
      } catch (err) {
        return { error: `Failed to get turn detail: ${err}` };
      }
    },
  });

  const getCriteriaTrajectory = defineTool("get_criteria_trajectory", {
    description:
      "Get the pass/fail trajectory for each criterion across all turns, including iteration duration. Useful for spotting regressions and flip-flops.",
    parameters: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/v1/requests/${requestId}`);
        if (!response.ok) {
          return { error: `Failed to fetch run: ${response.status} ${response.statusText}` };
        }
        const request: RequestDocument = await response.json();
        const run = request.run;
        const turns = run?.turns || [];

        // Collect all criterion IDs
        const criterionIds = new Set<string>();
        for (const turn of turns) {
          for (const cr of turn.criteriaResults || []) {
            criterionIds.add(cr.criterionId);
          }
        }

        // Build trajectory per criterion
        const trajectory: Record<string, { iteration: number; passed: boolean; evaluated: boolean; durationMs?: number }[]> = {};
        for (const id of criterionIds) {
          trajectory[id] = turns.map((turn: any) => {
            const cr = (turn.criteriaResults || []).find((c: any) => c.criterionId === id);
            return {
              iteration: turn.iteration,
              passed: cr?.passed ?? false,
              evaluated: cr?.evaluated ?? false,
              durationMs: turn.durationMs,
            };
          });
        }

        return { trajectory, criterionIds: [...criterionIds] };
      } catch (err) {
        return { error: `Failed to compute criteria trajectory: ${err}` };
      }
    },
  });

  const extractSnapshot = defineTool("extract_snapshot", {
    description:
      "Download and extract a workspace snapshot for a specific iteration to a local directory. " +
      "After extraction, use read_file, list_directory, and search_files to inspect the workspace contents. " +
      "Returns the path to the extracted directory.",
    parameters: {
      type: "object",
      properties: {
        iteration: {
          type: "number",
          description: "The iteration number (1-based) to download the snapshot for.",
        },
      },
      required: ["iteration"],
    },
    handler: async (args: { iteration: number }) => {
      const iterDir = join(snapshotsDir, `iteration-${args.iteration}`);
      
      // Check if already extracted
      if (existsSync(iterDir)) {
        return { path: iterDir, cached: true };
      }

      try {
        const response = await fetch(
          `${apiBaseUrl}/api/v1/requests/${requestId}/snapshots/${args.iteration}`
        );
        if (!response.ok) {
          return { error: `Failed to download snapshot: ${response.status} ${response.statusText}` };
        }

        const { mkdirSync } = await import("fs");
        mkdirSync(iterDir, { recursive: true });

        // Write tar.gz to temp file and extract
        const buffer = Buffer.from(await response.arrayBuffer());
        const tarPath = join(snapshotsDir, `iteration-${args.iteration}.tar.gz`);
        const { writeFileSync } = await import("fs");
        writeFileSync(tarPath, buffer);

        execSync(`tar -xzf "${tarPath}" -C "${iterDir}"`, { timeout: 30000 });

        // Clean up tar file
        const { unlinkSync } = await import("fs");
        unlinkSync(tarPath);

        return { path: iterDir, cached: false };
      } catch (err) {
        return { error: `Failed to extract snapshot: ${err}` };
      }
    },
  });

  const readFile = defineTool("read_file", {
    description:
      "Read a file from an extracted snapshot directory. Use after extract_snapshot to inspect workspace contents.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file (within an extracted snapshot directory).",
        },
      },
      required: ["path"],
    },
    handler: async (args: { path: string }) => {
      if (!args.path.startsWith(snapshotsDir)) {
        return { error: "Path must be within the snapshots directory" };
      }
      if (!existsSync(args.path)) {
        return { error: `File not found: ${args.path}` };
      }
      try {
        const stat = statSync(args.path);
        if (stat.isDirectory()) {
          return { error: `${args.path} is a directory, use list_directory instead` };
        }
        if (stat.size > 100_000) {
          const content = readFileSync(args.path, "utf-8").substring(0, 100_000);
          return { content, truncated: true, totalSize: stat.size };
        }
        return { content: readFileSync(args.path, "utf-8") };
      } catch (err) {
        return { error: `Failed to read file: ${err}` };
      }
    },
  });

  const listDirectory = defineTool("list_directory", {
    description:
      "List directory contents within an extracted snapshot. Use after extract_snapshot.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the directory (within an extracted snapshot directory).",
        },
      },
      required: ["path"],
    },
    handler: async (args: { path: string }) => {
      if (!args.path.startsWith(snapshotsDir)) {
        return { error: "Path must be within the snapshots directory" };
      }
      if (!existsSync(args.path)) {
        return { error: `Directory not found: ${args.path}` };
      }
      try {
        const entries = readdirSync(args.path, { withFileTypes: true });
        const items = entries
          .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
          .map((entry) => {
            const entryPath = join(args.path, entry.name);
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
      "Search for text patterns in files within an extracted snapshot using grep.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Text pattern or regex to search for.",
        },
        path: {
          type: "string",
          description: "Absolute path to search in (within an extracted snapshot directory).",
        },
        filePattern: {
          type: "string",
          description: "Glob pattern to filter files (e.g., '*.ts'). Optional.",
        },
      },
      required: ["pattern", "path"],
    },
    handler: async (args: { pattern: string; path: string; filePattern?: string }) => {
      if (!args.path.startsWith(snapshotsDir)) {
        return { error: "Path must be within the snapshots directory" };
      }
      try {
        const cmd = `grep -rn --include='${args.filePattern || "*"}' "${args.pattern.replace(/"/g, '\\"')}" "${args.path}" 2>/dev/null | head -50`;
        const output = execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
        if (!output) {
          return { matches: [], message: "No matches found" };
        }
        return { matches: output.split("\n") };
      } catch {
        return { matches: [], message: "No matches found or search error" };
      }
    },
  });

  const getAtifTrajectory = defineTool("get_atif_trajectory", {
    description:
      "Get the ATIF (AI Task Interchange Format) trajectory for a specific iteration or the latest one. " +
      "Returns the full structured trajectory including events, tool calls, and agent actions. " +
      "Use this to analyze the agent's step-by-step behavior during an iteration.",
    parameters: {
      type: "object",
      properties: {
        iteration: {
          type: "number",
          description:
            "The iteration number (1-based) to fetch the ATIF trajectory for.",
        },
      },
      required: ["iteration"],
    },
    handler: async (args: { iteration: number }) => {
      try {
        const url = `${apiBaseUrl}/api/v1/requests/${requestId}/atif?iteration=${args.iteration}`;
        const response = await fetch(url);
        if (!response.ok) {
          if (response.status === 404) {
            return { error: "No ATIF trajectory available for this iteration" };
          }
          return { error: `Failed to fetch ATIF: ${response.status} ${response.statusText}` };
        }
        const trajectory = await response.json();
        return { trajectory, iteration: args.iteration };
      } catch (err) {
        return { error: `Failed to fetch ATIF trajectory: ${err}` };
      }
    },
  });

  const searchInsights = defineTool("search_insights", {
    description:
      "Search existing insights by keyword query. Use this to check if a similar insight already exists before creating a new one. Returns matching insights sorted by reference count.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keyword search query to find similar insights.",
        },
      },
      required: ["query"],
    },
    handler: async (args: { query: string }) => {
      try {
        const response = await fetch(
          `${apiBaseUrl}/api/v1/insights/search?q=${encodeURIComponent(args.query)}&blocked=false`
        );
        if (!response.ok) {
          return { error: `Failed to search insights: ${response.status} ${response.statusText}` };
        }
        const insights = await response.json();
        return {
          insights: insights.map((i: any) => ({
            id: i._id,
            title: i.title,
            description: i.description,
            category: i.category,
            referenceCount: i.referenceCount,
          })),
          total: insights.length,
        };
      } catch (err) {
        return { error: `Failed to search insights: ${err}` };
      }
    },
  });

  const createInsight = defineTool("create_insight", {
    description:
      "Create a brand-new insight. Only use this when search_insights confirms no similar insight exists. The description should be markdown-formatted.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short summary of the insight (one line).",
        },
        description: {
          type: "string",
          description: "Detailed markdown-formatted observation explaining the insight.",
        },
        category: {
          type: "string",
          description: "Category tag (e.g. 'agent-behavior', 'criteria-handling', 'tool-usage', 'scenario-design').",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Free-form tags for discoverability.",
        },
      },
      required: ["title", "description"],
    },
    handler: async (args: { title: string; description: string; category?: string; tags?: string[] }) => {
      try {
        // Create the insight
        const createResponse = await fetch(`${apiBaseUrl}/api/v1/insights`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: args.title,
            description: args.description,
            category: args.category,
            tags: args.tags,
            createdBy: "agent",
            sourceReportId: reportId,
          }),
        });
        if (!createResponse.ok) {
          return { error: `Failed to create insight: ${createResponse.status} ${createResponse.statusText}` };
        }
        const insight = await createResponse.json();

        // Reference the insight from this report
        const refResponse = await fetch(`${apiBaseUrl}/api/v1/reports/${reportId}/insights`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ insightId: insight._id, isNew: true }),
        });
        if (!refResponse.ok) {
          return { id: insight._id, title: insight.title, warning: "Created but failed to link to report" };
        }

        return { id: insight._id, title: insight.title, created: true, linkedToReport: true };
      } catch (err) {
        return { error: `Failed to create insight: ${err}` };
      }
    },
  });

  const referenceInsight = defineTool("reference_insight", {
    description:
      "Reference an existing insight from this report. Use this when search_insights found a matching insight.",
    parameters: {
      type: "object",
      properties: {
        insightId: {
          type: "string",
          description: "The ID of the existing insight to reference.",
        },
      },
      required: ["insightId"],
    },
    handler: async (args: { insightId: string }) => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/v1/reports/${reportId}/insights`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ insightId: args.insightId, isNew: false }),
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          return { error: err.error || `Failed to reference insight: ${response.status}` };
        }
        return { insightId: args.insightId, referenced: true };
      } catch (err) {
        return { error: `Failed to reference insight: ${err}` };
      }
    },
  });

  return [
    getRunSummary,
    listTurns,
    getTurnDetail,
    getCriteriaTrajectory,
    getAtifTrajectory,
    extractSnapshot,
    readFile,
    listDirectory,
    searchFiles,
    searchInsights,
    createInsight,
    referenceInsight,
  ];
}
