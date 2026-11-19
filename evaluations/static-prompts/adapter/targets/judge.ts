// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import {
  type ConversationTurn,
  type CriteriaConfig,
  type CriterionResult,
  type DetailedEvaluationResult,
  type IterationToolCalls,
} from "../../../../packages/shared/src/index.js";
import {
  BundledStrategy,
  createJudgeCriteriaGraph,
  IndependentStrategy,
} from "../../../../apps/judge/src/judge-strategies.js";
import type {
  AdapterContext,
  AdapterExecution,
  ComposedPromptRequest,
  PromptTargetAdapter,
} from "../protocol.js";
import {
  objectArray,
  optionalString,
  record,
  requiredString,
} from "../validation.js";
import { normalizeTools, toolExecutionOptions } from "./common.js";

interface JudgeInput {
  criteria: CriteriaConfig[];
  conversationHistory: ConversationTurn[];
  iterationToolCalls: IterationToolCalls[];
  workspaceFiles: Record<string, string>;
  personaInstructions?: string;
  currentAgentResponse?: string;
  workspacePath: string;
}

interface NormalizedJudgeOutput {
  allPassed: boolean;
  results: CriterionResult[];
  evaluatedIds: string[];
  strategy: "bundled" | "independent";
}

abstract class CapturingJudgeSession {
  readonly requests: ComposedPromptRequest[] = [];
  readonly responses: string[] = [];

  constructor(
    protected readonly adapterContext: AdapterContext,
    private readonly workspaceFiles: Record<string, string>,
  ) {}

  async capture(
    adapterId: string,
    model: string,
    workspacePath: string,
    systemPrompt: string,
    userPrompt: string,
    iterationToolCalls?: IterationToolCalls[],
    currentAgentResponse?: string,
    createFileTools?: (workspacePath: string) => unknown[],
    createToolOutputTools?: (
      iterationToolCalls: IterationToolCalls[],
    ) => unknown[],
    createAgentResponseTools?: (response: string) => unknown[],
  ): Promise<string> {
    const hasToolCalls = (iterationToolCalls ?? []).some(
      (group) => group.toolCalls.length > 0,
    );
    const tools = [
      ...(createFileTools?.(workspacePath) ?? []),
      ...(hasToolCalls
        ? createToolOutputTools?.(iterationToolCalls ?? []) ?? []
        : []),
      ...(currentAgentResponse
        ? createAgentResponseTools?.(currentAgentResponse) ?? []
        : []),
    ];
    const request: ComposedPromptRequest = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      model,
      tools: normalizeTools(tools),
      ...(Object.keys(this.workspaceFiles).length
        ? {
            files: Object.entries(this.workspaceFiles).map(
              ([path, content]) => ({
                path,
                content,
                trust: "untrusted" as const,
              }),
            ),
          }
        : {}),
      metadata: {
        adapterId,
        productionSources: [
          "apps/judge/src/judge-strategies.ts",
          "apps/judge/src/tool-call-history.ts",
        ],
        fidelity: "exact",
      },
    };
    this.requests.push(request);
    const completion = await this.adapterContext.complete(
      request,
      toolExecutionOptions(tools),
    );
    this.responses.push(completion.content);
    return completion.content;
  }
}

class CapturingBundledStrategy extends BundledStrategy {
  readonly captureState: CapturingJudgeSession;

  constructor(context: AdapterContext, workspaceFiles: Record<string, string>) {
    super(context.model);
    this.captureState = new (class extends CapturingJudgeSession {})(
      context,
      workspaceFiles,
    );
  }

  protected override runCopilotSession(
    workspacePath: string,
    systemPrompt: string,
    userPrompt: string,
    iterationToolCalls?: IterationToolCalls[],
    currentAgentResponse?: string,
  ): Promise<string> {
    return this.captureState.capture(
      "judge-instructions/bundled",
      this.model,
      workspacePath,
      systemPrompt,
      userPrompt,
      iterationToolCalls,
      currentAgentResponse,
      (path) => this.createFileTools(path),
      (calls) => this.createToolOutputTools(calls),
      (response) => this.createAgentResponseTool(response),
    );
  }
}

class CapturingIndependentStrategy extends IndependentStrategy {
  readonly captureState: CapturingJudgeSession;

  constructor(context: AdapterContext, workspaceFiles: Record<string, string>) {
    super(context.model, 1);
    this.captureState = new (class extends CapturingJudgeSession {})(
      context,
      workspaceFiles,
    );
  }

  protected override runCopilotSession(
    workspacePath: string,
    systemPrompt: string,
    userPrompt: string,
    iterationToolCalls?: IterationToolCalls[],
    currentAgentResponse?: string,
  ): Promise<string> {
    return this.captureState.capture(
      "judge-instructions/independent",
      this.model,
      workspacePath,
      systemPrompt,
      userPrompt,
      iterationToolCalls,
      currentAgentResponse,
      (path) => this.createFileTools(path),
      (calls) => this.createToolOutputTools(calls),
      (response) => this.createAgentResponseTool(response),
    );
  }
}

function parseJudgeInput(input: unknown): JudgeInput {
  const value = record(input);
  const criteria = objectArray(value.criteria, "input.criteria", false).map(
    (criterion, index): CriteriaConfig => ({
      id: requiredString(criterion.id, `input.criteria[${index}].id`),
      prompt: requiredString(
        criterion.prompt,
        `input.criteria[${index}].prompt`,
      ),
      ...(Array.isArray(criterion.dependsOn)
        ? {
            dependsOn: criterion.dependsOn.map((id, dependencyIndex) =>
              requiredString(
                id,
                `input.criteria[${index}].dependsOn[${dependencyIndex}]`,
              ),
            ),
          }
        : {}),
    }),
  );
  if (criteria.length === 0) {
    throw new Error("input.criteria must contain at least one criterion");
  }

  const conversationHistory = objectArray(
    value.conversationHistory,
    "input.conversationHistory",
  ).map((turn, index): ConversationTurn => {
    const iteration =
      typeof turn.iteration === "number" ? turn.iteration : index + 1;
    const criteriaResults = objectArray(
      turn.criteriaResults,
      `input.conversationHistory[${index}].criteriaResults`,
    ).map((result, resultIndex): CriterionResult => ({
      criterionId: requiredString(
        result.criterionId,
        `input.conversationHistory[${index}].criteriaResults[${resultIndex}].criterionId`,
      ),
      passed: result.passed === true,
      feedback:
        typeof result.feedback === "string" ? result.feedback : "",
      evaluated: result.evaluated !== false,
    }));
    return {
      iteration,
      judgeFeedback:
        typeof turn.judgeFeedback === "string" ? turn.judgeFeedback : "",
      snapshotUrl:
        typeof turn.snapshotUrl === "string" ? turn.snapshotUrl : "",
      passed: turn.passed === true,
      timestamp:
        typeof turn.timestamp === "string" ||
        typeof turn.timestamp === "number"
          ? new Date(turn.timestamp)
          : new Date(0),
      ...(typeof turn.codingAgentResponse === "string"
        ? { codingAgentResponse: turn.codingAgentResponse }
        : {}),
      ...(criteriaResults.length ? { criteriaResults } : {}),
    };
  });

  const iterationToolCalls = objectArray(
    value.iterationToolCalls,
    "input.iterationToolCalls",
  ).map((group, index): IterationToolCalls => ({
    iteration:
      typeof group.iteration === "number" ? group.iteration : index + 1,
    toolCalls: Array.isArray(group.toolCalls)
      ? (group.toolCalls as IterationToolCalls["toolCalls"])
      : [],
  }));
  const workspaceFilesValue =
    value.workspaceFiles === undefined
      ? {}
      : record(value.workspaceFiles, "input.workspaceFiles");
  const workspaceFiles = Object.fromEntries(
    Object.entries(workspaceFilesValue).map(([path, content]) => {
      const relativePath = requiredString(
        path,
        "input.workspaceFiles path",
      );
      if (
        isAbsolute(relativePath) ||
        relativePath === "." ||
        relativePath.split(/[\\/]/).includes("..")
      ) {
        throw new Error(
          `input.workspaceFiles contains unsafe relative path '${relativePath}'`,
        );
      }
      if (typeof content !== "string") {
        throw new Error(
          `input.workspaceFiles[${JSON.stringify(relativePath)}] must be a string`,
        );
      }
      return [
        relativePath,
        content,
      ];
    }),
  );

  return {
    criteria,
    conversationHistory,
    iterationToolCalls,
    workspaceFiles,
    workspacePath:
      optionalString(value.workspacePath, "input.workspacePath") ??
      process.cwd(),
    ...(optionalString(
      value.personaInstructions,
      "input.personaInstructions",
    )
      ? {
          personaInstructions: optionalString(
            value.personaInstructions,
            "input.personaInstructions",
          ),
        }
      : {}),
    ...(optionalString(
      value.currentAgentResponse,
      "input.currentAgentResponse",
    )
      ? {
          currentAgentResponse: optionalString(
            value.currentAgentResponse,
            "input.currentAgentResponse",
          ),
        }
      : {}),
  };
}

export async function composeJudgeRequest(
  input: unknown,
  variant: "bundled" | "independent",
  context: AdapterContext,
): Promise<{
  execution: AdapterExecution<NormalizedJudgeOutput>;
  requests: ComposedPromptRequest[];
}> {
  const parsed = parseJudgeInput(input);
  const materializedWorkspace = materializeWorkspaceFiles(parsed.workspaceFiles);
  const strategy =
    variant === "bundled"
      ? new CapturingBundledStrategy(context, parsed.workspaceFiles)
      : new CapturingIndependentStrategy(context, parsed.workspaceFiles);
  let result: DetailedEvaluationResult;
  try {
    result = await strategy.evaluate({
      workspacePath: materializedWorkspace,
      criteria: parsed.criteria,
      criteriaGraph: createJudgeCriteriaGraph(parsed.criteria),
      conversationHistory: parsed.conversationHistory,
      iterationToolCalls: parsed.iterationToolCalls,
      personaInstructions: parsed.personaInstructions,
      currentAgentResponse: parsed.currentAgentResponse,
    });
  } finally {
    cleanupMaterializedWorkspace(materializedWorkspace);
  }
  const requests = strategy.captureState.requests;
  const responses = strategy.captureState.responses;
  if (!requests[0] || !responses[0]) {
    throw new Error("Judge strategy did not invoke a model session");
  }
  return {
    requests,
    execution: {
      request: requests[0],
      rawResponse: responses.join("\n"),
      output: {
        allPassed: result.allPassed,
        results: result.results,
        evaluatedIds: [...result.evaluatedIds],
        strategy: result.strategy,
      },
      invocationMetadata: {
        requestCount: requests.length,
        ...(requests.length > 1 ? { additionalRequests: requests.slice(1) } : {}),
      },
    },
  };
}

function materializeWorkspaceFiles(files: Record<string, string>): string {
  const workspacePath = mkdtempSync(
    join(tmpdir(), "scope-static-prompt-judge-"),
  );
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const destination = join(workspacePath, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content, "utf8");
    }
    return workspacePath;
  } catch (error) {
    cleanupMaterializedWorkspace(workspacePath);
    throw error;
  }
}

function cleanupMaterializedWorkspace(workspacePath: string): void {
  rmSync(workspacePath, { recursive: true, force: true });
}

export const judgeAdapter: PromptTargetAdapter<NormalizedJudgeOutput> = {
  family: "judge-instructions",
  variants: ["bundled", "independent"],
  async run(input, variant, context) {
    if (variant !== "bundled" && variant !== "independent") {
      throw new Error(`Unsupported judge variant '${variant}'`);
    }
    return (await composeJudgeRequest(input, variant, context)).execution;
  },
};
