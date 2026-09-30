// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  PromptFeatureConfig,
  PromptType,
} from "../../../../packages/shared/src/index.js";
import {
  buildPromptFeatureAuthoringRequest,
  buildPromptFeatureExtractionRequest,
  parsePromptFeatureAuthoringResponse,
  parsePromptFeatureExtractionResponse,
  type ExistingPromptFeature,
} from "../../../../apps/api/src/prompt-feature-llm.js";
import type { PromptTargetAdapter } from "../protocol.js";
import {
  objectArray,
  optionalString,
  record,
  requiredString,
} from "../validation.js";
import { normalizeProductionChatRequest } from "./common.js";

function parseFeatures(
  value: unknown,
  label: string,
): PromptFeatureConfig[] {
  return objectArray(value, label).map((feature, index) => ({
    id: requiredString(feature.id, `${label}[${index}].id`),
    prompt: requiredString(feature.prompt, `${label}[${index}].prompt`),
    ...(optionalString(feature.type, `${label}[${index}].type`)
      ? {
          type: optionalString(
            feature.type,
            `${label}[${index}].type`,
          ) as PromptType,
        }
      : {}),
  }));
}

export const promptFeatureAuthoringAdapter: PromptTargetAdapter = {
  family: "prompt-feature-authoring",
  variants: ["default"],
  async run(input, _variant, context) {
    const value = record(input);
    const behavior = requiredString(value.behavior, "input.behavior");
    const existingFeatures = parseFeatures(
      value.existingFeatures,
      "input.existingFeatures",
    ) satisfies ExistingPromptFeature[];
    const model = optionalString(value.model, "input.model") ?? context.model;
    const request = normalizeProductionChatRequest(
      "prompt-feature-authoring/default",
      [
        "apps/api/src/prompt-feature-llm.ts#buildPromptFeatureAuthoringRequest",
        "apps/api/src/prompt-feature-llm.ts#parsePromptFeatureAuthoringResponse",
      ],
      buildPromptFeatureAuthoringRequest(behavior, existingFeatures, model),
    );
    const completion = await context.complete(request);
    return {
      request,
      rawResponse: completion.content,
      output: parsePromptFeatureAuthoringResponse(
        completion.content,
        existingFeatures,
      ),
      invocationMetadata: completion.metadata,
    };
  },
};

export const promptFeatureExtractionAdapter: PromptTargetAdapter = {
  family: "prompt-feature-extraction",
  variants: ["default"],
  async run(input, _variant, context) {
    const value = record(input);
    const taskText = requiredString(value.taskText, "input.taskText");
    const features = parseFeatures(value.features, "input.features");
    const model = optionalString(value.model, "input.model") ?? context.model;
    const request = normalizeProductionChatRequest(
      "prompt-feature-extraction/default",
      [
        "apps/api/src/prompt-feature-llm.ts#buildPromptFeatureExtractionRequest",
        "apps/api/src/prompt-feature-llm.ts#parsePromptFeatureExtractionResponse",
      ],
      buildPromptFeatureExtractionRequest(taskText, features, model),
    );
    const completion = await context.complete(request);
    return {
      request,
      rawResponse: completion.content,
      output: parsePromptFeatureExtractionResponse(
        completion.content,
        features,
      ),
      invocationMetadata: completion.metadata,
    };
  },
};
