// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  type CriteriaConfig,
  type CriterionResult,
} from "../../../../packages/shared/src/index.js";
import {
  buildFeedbackPromptRequestFromCriteria,
  type FeedbackPromptInput,
} from "../../../../apps/judge/src/feedback-generator.js";
import type {
  AdapterContext,
  ComposedPromptRequest,
  PromptTargetAdapter,
} from "../protocol.js";
import {
  objectArray,
  optionalBoolean,
  optionalPositiveInteger,
  optionalString,
  record,
  requiredString,
} from "../validation.js";

export function parseFeedbackContext(input: unknown): FeedbackPromptInput {
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
  const judgeResults = objectArray(
    value.judgeResults,
    "input.judgeResults",
    false,
  ).map((result, index): CriterionResult => ({
    criterionId: requiredString(
      result.criterionId,
      `input.judgeResults[${index}].criterionId`,
    ),
    passed: result.passed === true,
    feedback:
      typeof result.feedback === "string" ? result.feedback : "",
    evaluated: result.evaluated !== false,
  }));
  const personaInstructions = optionalString(
    value.personaInstructions,
    "input.personaInstructions",
  );
  const maxCriteria = optionalPositiveInteger(
    value.maxCriteria,
    "input.maxCriteria",
  );
  const includeDescendantGuard = optionalBoolean(
    value.includeDescendantGuard,
    "input.includeDescendantGuard",
  );

  return {
    judgeResults,
    criteria,
    ...(personaInstructions ? { personaInstructions } : {}),
    ...(maxCriteria === undefined ? {} : { maxCriteria }),
    ...(includeDescendantGuard === undefined
      ? {}
      : { includeDescendantGuard }),
  };
}

export function composeFeedbackRequest(
  input: unknown,
  model: string,
  variant: string,
): {
  request: ComposedPromptRequest;
  selectedCriteriaIds: string[];
} | null {
  const composed = buildFeedbackPromptRequestFromCriteria(
    parseFeedbackContext(input),
  );
  if (!composed) return null;
  return {
    request: {
      messages: [
        { role: "system", content: composed.systemPrompt },
        { role: "user", content: composed.userPrompt },
      ],
      model,
      metadata: {
        adapterId: `developer-feedback/${variant}`,
        productionSources: [
          "apps/judge/src/feedback-generator.ts#buildFeedbackPromptRequest",
        ],
        fidelity: "exact",
      },
    },
    selectedCriteriaIds: composed.selectedCriteriaIds,
  };
}

export const feedbackAdapter: PromptTargetAdapter = {
  family: "developer-feedback",
  variants: ["default", "persona", "descendant-guard"],
  async run(input, variant, context) {
    const composed = composeFeedbackRequest(input, context.model, variant);
    if (!composed) {
      const request: ComposedPromptRequest = {
        messages: [],
        model: context.model,
        metadata: {
          adapterId: `developer-feedback/${variant}`,
          productionSources: [
            "apps/judge/src/feedback-generator.ts#buildFeedbackPromptRequest",
          ],
          fidelity: "exact",
        },
      };
      return {
        request,
        rawResponse: "All requirements met.",
        output: { feedback: "All requirements met.", selectedCriteriaIds: [] },
        invocationMetadata: { skippedTransport: "no-root-failures" },
      };
    }
    const completion = await context.complete(composed.request);
    return {
      request: composed.request,
      rawResponse: completion.content,
      output: {
        feedback: completion.content.trim(),
        selectedCriteriaIds: composed.selectedCriteriaIds,
      },
      invocationMetadata: completion.metadata,
    };
  },
};
