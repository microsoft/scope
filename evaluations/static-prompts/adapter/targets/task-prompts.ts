// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  buildTaskPromptRequest,
  parseTaskPromptResponse,
} from "../../../../apps/api/src/task-prompt-llm.js";
import type { PromptTargetAdapter } from "../protocol.js";
import {
  optionalString,
  record,
  stringArray,
} from "../validation.js";
import { normalizeProductionChatRequest } from "./common.js";

interface TaskPromptInput {
  description?: string;
  existingPrompt?: string;
  existingPrompts: string[];
  model?: string;
}

function parseTaskPromptInput(
  input: unknown,
  variation: boolean,
): TaskPromptInput {
  const value = record(input);
  const existingPrompt = optionalString(
    value.existingPrompt,
    "input.existingPrompt",
  );
  if (variation && !existingPrompt) {
    throw new Error(
      "input.existingPrompt is required for task-prompt-variation",
    );
  }
  return {
    ...(optionalString(value.description, "input.description")
      ? { description: optionalString(value.description, "input.description") }
      : {}),
    ...(existingPrompt ? { existingPrompt } : {}),
    existingPrompts: stringArray(
      value.existingPrompts,
      "input.existingPrompts",
    ),
    ...(optionalString(value.model, "input.model")
      ? { model: optionalString(value.model, "input.model") }
      : {}),
  };
}

function taskPromptAdapter(
  family: "task-prompt-generation" | "task-prompt-variation",
  variation: boolean,
): PromptTargetAdapter {
  return {
    family,
    variants: ["default"],
    async run(input, _variant, context) {
      const parsed = parseTaskPromptInput(input, variation);
      const request = normalizeProductionChatRequest(
        `${family}/default`,
        [
          "apps/api/src/task-prompt-llm.ts#buildTaskPromptRequest",
          "apps/api/src/task-prompt-llm.ts#parseTaskPromptResponse",
        ],
        buildTaskPromptRequest(
          {
            description: parsed.description,
            existingPrompt: parsed.existingPrompt,
          },
          parsed.existingPrompts,
          parsed.model ?? context.model,
        ),
      );
      const completion = await context.complete(request);
      return {
        request,
        rawResponse: completion.content,
        output: parseTaskPromptResponse(completion.content),
        invocationMetadata: completion.metadata,
      };
    },
  };
}

export const taskPromptGenerationAdapter = taskPromptAdapter(
  "task-prompt-generation",
  false,
);

export const taskPromptVariationAdapter = taskPromptAdapter(
  "task-prompt-variation",
  true,
);
