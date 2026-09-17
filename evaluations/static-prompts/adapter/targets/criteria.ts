// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { GateId } from "../../../../packages/shared/src/index.js";
import {
  buildCriteriaAuthoringRequest,
  buildCriteriaDependencySuggestionRequest,
  parseCriteriaAuthoringResponse,
  parseCriteriaDependencySuggestionResponse,
  selectCriteriaDependencyPool,
  type ExistingCriterion,
  type SuggestDirection,
} from "../../../../apps/api/src/llm.js";
import type {
  AdapterContext,
  AdapterExecution,
  PromptTargetAdapter,
} from "../protocol.js";
import {
  objectArray,
  optionalString,
  record,
  requiredString,
  stringArray,
} from "../validation.js";
import { normalizeProductionChatRequest } from "./common.js";

interface CriteriaInput {
  behavior: string;
  existingCriteria: ExistingCriterion[];
  gates?: GateId[];
  model?: string;
}

function parseCriteriaInput(input: unknown): CriteriaInput {
  const value = record(input);
  const gates = stringArray(value.gates, "input.gates").map((gate) => {
    if (!["select", "build", "test", "run", "deploy"].includes(gate)) {
      throw new Error(`input.gates contains unsupported gate '${gate}'`);
    }
    return gate as GateId;
  });
  const existingCriteria = objectArray(
    value.existingCriteria,
    "input.existingCriteria",
  ).map((criterion, index) => ({
    id: requiredString(
      criterion.id,
      `input.existingCriteria[${index}].id`,
    ),
    prompt: requiredString(
      criterion.prompt,
      `input.existingCriteria[${index}].prompt`,
    ),
    dependsOn: stringArray(
      criterion.dependsOn,
      `input.existingCriteria[${index}].dependsOn`,
    ),
    gates: stringArray(
      criterion.gates,
      `input.existingCriteria[${index}].gates`,
    ) as GateId[],
  }));
  return {
    behavior: requiredString(value.behavior, "input.behavior"),
    existingCriteria,
    ...(gates.length ? { gates } : {}),
    ...(optionalString(value.model, "input.model")
      ? { model: optionalString(value.model, "input.model") }
      : {}),
  };
}

export const criteriaAuthoringAdapter: PromptTargetAdapter = {
  family: "criteria-authoring",
  variants: ["default"],
  async run(input, _variant, context) {
    const parsed = parseCriteriaInput(input);
    const request = normalizeProductionChatRequest(
      "criteria-authoring/default",
      ["apps/api/src/llm.ts#buildCriteriaAuthoringRequest"],
      buildCriteriaAuthoringRequest(
        parsed.behavior,
        parsed.gates,
        parsed.model ?? context.model,
      ),
    );
    const completion = await context.complete(request);
    return {
      request,
      rawResponse: completion.content,
      output: parseCriteriaAuthoringResponse(completion.content),
      invocationMetadata: completion.metadata,
    };
  },
};

function dependencyAdapter(
  family:
    | "parent-dependency-suggestion"
    | "child-dependency-suggestion",
  direction: SuggestDirection,
): PromptTargetAdapter<string[]> {
  return {
    family,
    variants: ["default"],
    async run(input, _variant, context): Promise<AdapterExecution<string[]>> {
      const parsed = parseCriteriaInput(input);
      const pool = selectCriteriaDependencyPool(
        direction,
        parsed.existingCriteria,
        parsed.gates,
      );
      if (pool.length === 0) {
        const request = normalizeProductionChatRequest(
          `${family}/default`,
          [
            "apps/api/src/llm.ts#selectCriteriaDependencyPool",
            "apps/api/src/llm.ts#buildCriteriaDependencySuggestionRequest",
          ],
          buildCriteriaDependencySuggestionRequest(
            direction,
            parsed.behavior,
            pool,
            parsed.model ?? context.model,
          ),
        );
        return {
          request,
          rawResponse: '{"suggestions":[]}',
          output: [],
          invocationMetadata: { skippedTransport: "empty-candidate-pool" },
        };
      }
      const request = normalizeProductionChatRequest(
        `${family}/default`,
        [
          "apps/api/src/llm.ts#selectCriteriaDependencyPool",
          "apps/api/src/llm.ts#buildCriteriaDependencySuggestionRequest",
          "apps/api/src/llm.ts#parseCriteriaDependencySuggestionResponse",
        ],
        buildCriteriaDependencySuggestionRequest(
          direction,
          parsed.behavior,
          pool,
          parsed.model ?? context.model,
        ),
      );
      const completion = await context.complete(request);
      return {
        request,
        rawResponse: completion.content,
        output: parseCriteriaDependencySuggestionResponse(
          completion.content,
          pool,
        ),
        invocationMetadata: completion.metadata,
      };
    },
  };
}

export const parentDependencySuggestionAdapter = dependencyAdapter(
  "parent-dependency-suggestion",
  "parents",
);

export const childDependencySuggestionAdapter = dependencyAdapter(
  "child-dependency-suggestion",
  "children",
);
