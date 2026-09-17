// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  buildPromptFeatureExtractionRequest,
} from "../../../apps/api/src/prompt-feature-llm.js";
import type { PromptFeatureConfig } from "../../../packages/shared/src/index.js";
import type {
  AdapterContext,
  ComposedPromptRequest,
  RedTeamComposition,
  RedTeamSurface,
} from "./protocol.js";
import {
  objectArray,
  optionalString,
  record,
  requiredString,
} from "./validation.js";
import { normalizeProductionChatRequest } from "./targets/common.js";
import { composeFeedbackRequest } from "./targets/feedback.js";
import { composeJudgeRequest } from "./targets/judge.js";
import { composeReportRequest } from "./targets/reports.js";

const SOURCE_REVISION = sourceRevision();

export async function composeRedTeamSurface(
  surface: RedTeamSurface,
  attack: string,
  input: unknown,
  model: string,
): Promise<RedTeamComposition> {
  const payload = requiredString(attack, "attack");
  const value = input === undefined ? {} : record(input);
  let request: ComposedPromptRequest;

  switch (surface) {
    case "task-scenario-prompt":
      request = directCodingRequest(
        "red-team/task-scenario-prompt",
        payload,
        "scenario.task → Select gate → WorkerProcessor.processMessage(prompt)",
        model,
      );
      break;
    case "gate-prompt":
      request = directCodingRequest(
        "red-team/gate-prompt",
        payload,
        "GateConfig.promptId → resolved prompt text → WorkerProcessor.processMessage(prompt)",
        model,
      );
      break;
    case "agents-md": {
      const taskPrompt = requiredString(
        value.taskPrompt,
        "input.taskPrompt",
      );
      request = {
        messages: [{ role: "user", content: taskPrompt }],
        files: [
          {
            path: "AGENTS.md",
            content: payload,
            trust: "untrusted",
          },
        ],
        model,
        metadata: {
          adapterId: "red-team/agents-md",
          productionSources: [
            "packages/shared/src/queue/queue-processor.ts#writeAgentsMd",
            "packages/shared/src/judge/multi-turn-loop.ts#runMultiTurnLoop",
          ],
          insertionPoint:
            "Resolved agentsMdPromptId is written to workspace/AGENTS.md before the task prompt is sent",
          fidelity: "partial",
        },
      };
      break;
    }
    case "criterion-prompt": {
      const judgeVariant =
        optionalString(value.judgeVariant, "input.judgeVariant") ?? "bundled";
      if (judgeVariant !== "bundled" && judgeVariant !== "independent") {
        throw new Error(
          "input.judgeVariant must be 'bundled' or 'independent'",
        );
      }
      const criterionId =
        optionalString(value.criterionId, "input.criterionId") ??
        "red_team_criterion";
      const criteria = objectArray(value.criteria, "input.criteria").map(
        (criterion, index) => ({
          id: requiredString(
            criterion.id,
            `input.criteria[${index}].id`,
          ),
          prompt: requiredString(
            criterion.prompt,
            `input.criteria[${index}].prompt`,
          ),
          ...(Array.isArray(criterion.dependsOn)
            ? { dependsOn: criterion.dependsOn }
            : {}),
        }),
      );
      const replacedCriteria = criteria.some(
        (criterion) => criterion.id === criterionId,
      )
        ? criteria.map((criterion) =>
            criterion.id === criterionId
              ? { ...criterion, prompt: payload }
              : criterion,
          )
        : [...criteria, { id: criterionId, prompt: payload }];
      const result = await composeJudgeRequest(
        {
          ...value,
          criteria: replacedCriteria,
          conversationHistory: value.conversationHistory ?? [],
          iterationToolCalls: value.iterationToolCalls ?? [],
        },
        judgeVariant,
        captureOnlyContext(model, "FAIL:\nRed-team composition probe."),
      );
      request = {
        ...result.requests[0],
        metadata: {
          ...result.requests[0].metadata,
          adapterId: "red-team/criterion-prompt",
          insertionPoint:
            `CriteriaConfig.prompt in the ${judgeVariant} judge user message`,
        },
      };
      break;
    }
    case "prompt-feature-definition": {
      const featureId =
        optionalString(value.featureId, "input.featureId") ??
        "red_team_feature";
      const features = objectArray(value.features, "input.features").map(
        (feature, index): PromptFeatureConfig => ({
          id: requiredString(feature.id, `input.features[${index}].id`),
          prompt: requiredString(
            feature.prompt,
            `input.features[${index}].prompt`,
          ),
        }),
      );
      const replacedFeatures = features.some(
        (feature) => feature.id === featureId,
      )
        ? features.map((feature) =>
            feature.id === featureId
              ? { ...feature, prompt: payload }
              : feature,
          )
        : [...features, { id: featureId, prompt: payload }];
      request = normalizeProductionChatRequest(
        "red-team/prompt-feature-definition",
        [
          "apps/api/src/prompt-feature-llm.ts#buildPromptFeatureExtractionRequest",
        ],
        buildPromptFeatureExtractionRequest(
          requiredString(value.taskText, "input.taskText"),
          replacedFeatures,
          model,
        ),
        {
          insertionPoint:
            "PromptFeatureConfig.prompt in the feature list of the extraction user message",
        },
      );
      break;
    }
    case "persona-instructions": {
      const composed = composeFeedbackRequest(
        { ...value, personaInstructions: payload },
        model,
        "persona",
      );
      if (!composed) {
        throw new Error(
          "persona-instructions requires at least one root failing judge result",
        );
      }
      request = {
        ...composed.request,
        metadata: {
          ...composed.request.metadata,
          adapterId: "red-team/persona-instructions",
          insertionPoint:
            "FeedbackContext.personaInstructions replaces the default feedback system instructions",
        },
      };
      break;
    }
    case "report-user-prompt":
      request = composeReportRequest(
        {
          ...value,
          requestId: requiredString(value.requestId, "input.requestId"),
          userPrompt: payload,
        },
        "default",
        model,
      );
      request.metadata = {
        ...request.metadata,
        adapterId: "red-team/report-user-prompt",
        insertionPoint:
          "ReportTemplateDocument.userPrompt after requestId substitution",
      };
      break;
    case "report-system-prompt": {
      const mode =
        optionalString(value.systemPromptMode, "input.systemPromptMode") ??
        "append";
      if (mode !== "append" && mode !== "override") {
        throw new Error(
          "input.systemPromptMode must be 'append' or 'override'",
        );
      }
      request = composeReportRequest(
        {
          ...value,
          requestId: requiredString(value.requestId, "input.requestId"),
          userPrompt: requiredString(value.userPrompt, "input.userPrompt"),
          systemPromptMode: mode,
          systemPromptContent: payload,
        },
        mode === "append" ? "append" : "override-control",
        model,
      );
      request.metadata = {
        ...request.metadata,
        adapterId: "red-team/report-system-prompt",
        insertionPoint: `ReportTemplateDocument.systemPrompt.content (${mode} mode)`,
      };
      break;
    }
  }

  return {
    surface,
    request,
    compositionFingerprint: fingerprint(request),
    sourceRevision: SOURCE_REVISION,
  };
}

function directCodingRequest(
  adapterId: string,
  prompt: string,
  insertionPoint: string,
  model: string,
): ComposedPromptRequest {
  return {
    messages: [{ role: "user", content: prompt }],
    model,
    metadata: {
      adapterId,
      productionSources: [
        "packages/shared/src/queue/queue-processor.ts",
        "packages/shared/src/judge/gated-loop.ts",
        "packages/shared/src/judge/multi-turn-loop.ts",
      ],
      insertionPoint,
      fidelity: "exact",
    },
  };
}

function captureOnlyContext(
  model: string,
  response: string,
): AdapterContext {
  return {
    model,
    async complete() {
      return { content: response, metadata: { captureOnly: true } };
    },
  };
}

function fingerprint(request: ComposedPromptRequest): string {
  return createHash("sha256")
    .update(stableStringify(request))
    .digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify(object[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sourceRevision(): string {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    const root = new URL("../../..", import.meta.url);
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return dirty ? `${revision}-dirty` : revision;
  } catch {
    return "unknown";
  }
}
