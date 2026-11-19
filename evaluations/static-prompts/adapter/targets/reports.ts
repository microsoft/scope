// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ReportTemplateSystemPrompt } from "../../../../packages/shared/src/index.js";
import { createReportTools } from "../../../../apps/workers/report-generator/src/tools.js";
import { resolveReportPrompts } from "../../../../apps/workers/report-generator/src/report-queue-processor.js";
import type {
  CompletionOptions,
  ComposedPromptRequest,
  PromptTargetAdapter,
} from "../protocol.js";
import { optionalString, record, requiredString } from "../validation.js";
import { normalizeTools } from "./common.js";

interface ReportInput {
  requestId: string;
  reportId: string;
  userPrompt: string;
  systemPrompt?: ReportTemplateSystemPrompt;
  apiBaseUrl: string;
  snapshotsDir: string;
  model?: string;
  evidenceContext?: Record<string, unknown>;
}

function parseReportInput(input: unknown, variant: string): ReportInput {
  const value = record(input);
  const systemPromptContent = optionalString(
    value.systemPromptContent,
    "input.systemPromptContent",
  );
  const requestedMode = optionalString(
    value.systemPromptMode,
    "input.systemPromptMode",
  );
  const mode: ReportTemplateSystemPrompt["mode"] | undefined =
    variant === "append"
      ? "append"
      : variant === "override-control"
        ? "override"
        : requestedMode === "append" || requestedMode === "override"
          ? requestedMode
          : undefined;
  if (requestedMode && !mode) {
    throw new Error("input.systemPromptMode must be 'append' or 'override'");
  }
  if (mode && !systemPromptContent) {
    throw new Error(
      `input.systemPromptContent is required for report variant '${variant}'`,
    );
  }
  return {
    requestId: requiredString(value.requestId, "input.requestId"),
    reportId:
      optionalString(value.reportId, "input.reportId") ?? "prompt-eval-report",
    userPrompt: requiredString(value.userPrompt, "input.userPrompt"),
    apiBaseUrl:
      optionalString(value.apiBaseUrl, "input.apiBaseUrl") ??
      "http://scope.invalid",
    snapshotsDir:
      optionalString(value.snapshotsDir, "input.snapshotsDir") ??
      process.cwd(),
    ...(mode && systemPromptContent
      ? { systemPrompt: { mode, content: systemPromptContent } }
      : {}),
    ...(optionalString(value.model, "input.model")
      ? { model: optionalString(value.model, "input.model") }
      : {}),
    ...(value.evidenceContext === undefined
      ? {}
      : {
          evidenceContext: record(
            value.evidenceContext,
            "input.evidenceContext",
          ),
        }),
  };
}

function createFixtureToolOptions(
  evidenceContext: Record<string, unknown> | undefined,
): CompletionOptions {
  const request = evidenceContext
    ? record(evidenceContext.request, "input.evidenceContext.request")
    : {};
  const turns = Array.isArray(request.turns)
    ? request.turns.filter(
        (turn): turn is Record<string, unknown> =>
          typeof turn === "object" && turn !== null && !Array.isArray(turn),
      )
    : [];
  return {
    async executeTool(name, arguments_) {
      const args =
        typeof arguments_ === "object" &&
        arguments_ !== null &&
        !Array.isArray(arguments_)
          ? (arguments_ as Record<string, unknown>)
          : {};
      switch (name) {
        case "get_run_summary":
          return request;
        case "list_turns":
          return { turns, total: turns.length };
        case "get_turn_detail": {
          const iteration = args.iteration;
          const turn = turns.find((candidate) => candidate.iteration === iteration);
          return turn ?? { error: `Turn ${String(iteration)} not found` };
        }
        case "get_criteria_trajectory": {
          const criterionIds = new Set<string>();
          for (const turn of turns) {
            if (!Array.isArray(turn.criteriaResults)) continue;
            for (const result of turn.criteriaResults) {
              if (
                result &&
                typeof result === "object" &&
                !Array.isArray(result) &&
                typeof (result as Record<string, unknown>).criterionId ===
                  "string"
              ) {
                criterionIds.add(
                  (result as Record<string, unknown>).criterionId as string,
                );
              }
            }
          }
          return {
            criterionIds: [...criterionIds],
            trajectory: Object.fromEntries(
              [...criterionIds].map((criterionId) => [
                criterionId,
                turns.map((turn) => {
                  const results = Array.isArray(turn.criteriaResults)
                    ? turn.criteriaResults
                    : [];
                  const result = results.find(
                    (candidate) =>
                      candidate &&
                      typeof candidate === "object" &&
                      !Array.isArray(candidate) &&
                      (candidate as Record<string, unknown>).criterionId ===
                        criterionId,
                  ) as Record<string, unknown> | undefined;
                  return {
                    iteration: turn.iteration,
                    passed: result?.passed === true,
                    evaluated: result?.evaluated !== false,
                  };
                }),
              ]),
            ),
          };
        }
        case "get_atif_trajectory":
          return { error: "No ATIF trajectory is included in this curated case" };
        case "extract_snapshot":
        case "read_file":
        case "list_directory":
        case "search_files":
          return { error: "No workspace snapshot is included in this curated case" };
        case "search_insights":
          return { insights: [], total: 0 };
        case "create_insight":
        case "reference_insight":
          return { recorded: true, evaluationOnly: true };
        default:
          throw new Error(`No evaluation fixture handler for report tool '${name}'`);
      }
    },
  };
}

function composeParsedReportRequest(
  parsed: ReportInput,
  variant: string,
  defaultModel: string,
): ComposedPromptRequest {
  const prompts = resolveReportPrompts(
    {
      userPrompt: parsed.userPrompt,
      systemPrompt: parsed.systemPrompt,
    },
    parsed.requestId,
  );
  const tools = createReportTools(
    parsed.apiBaseUrl,
    parsed.requestId,
    parsed.snapshotsDir,
    parsed.reportId,
  );
  return {
    messages: [
      { role: "system", content: prompts.systemPrompt },
      { role: "user", content: prompts.userPrompt },
    ],
    model: parsed.model ?? defaultModel,
    tools: normalizeTools(tools),
    metadata: {
      adapterId: `run-report/${variant}`,
      productionSources: [
        "apps/workers/report-generator/src/report-queue-processor.ts#resolveReportPrompts",
        "apps/workers/report-generator/src/tools.ts#createReportTools",
        "packages/shared/src/report-templates/prompt.ts#REPORT_SYSTEM_PROMPT",
      ],
      fidelity: "exact",
    },
  };
}

export function composeReportRequest(
  input: unknown,
  variant: string,
  defaultModel: string,
): ComposedPromptRequest {
  return composeParsedReportRequest(
    parseReportInput(input, variant),
    variant,
    defaultModel,
  );
}

export const reportAdapter: PromptTargetAdapter<string> = {
  family: "run-report",
  variants: ["default", "append", "override-control"],
  async run(input, variant, context) {
    const parsed = parseReportInput(input, variant);
    const request = composeParsedReportRequest(parsed, variant, context.model);
    const completion = await context.complete(
      request,
      createFixtureToolOptions(parsed.evidenceContext),
    );
    return {
      request,
      rawResponse: completion.content,
      output: completion.content.trim(),
      invocationMetadata: completion.metadata,
    };
  },
};
