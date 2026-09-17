// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequestBody } from "shared";
import { clearChatCompletionCompatibilityCache } from "./adaptive-chat-completions.js";
import {
  buildCriteriaAuthoringRequest,
  generateCriteriaPrompt,
} from "./llm.js";
import {
  buildPromptFeatureAuthoringRequest,
  buildPromptFeatureExtractionRequest,
  extractPromptFeatures,
  generatePromptFeaturePrompt,
} from "./prompt-feature-llm.js";
import {
  buildTaskPromptRequest,
  generateTaskPrompt,
} from "./task-prompt-llm.js";

const mockPost = vi.fn<
  (options: { body: ChatCompletionRequestBody }) => Promise<{
    status: string;
    body: unknown;
  }>
>();

vi.mock("@azure-rest/ai-inference", () => ({
  isUnexpected: (response: { status: string }) => response.status !== "200",
}));

vi.mock("./llm-token.js", () => ({
  acquireInferenceClient: async () => ({
    client: { path: () => ({ post: mockPost }) },
    endpoint: "https://prompt-transport.example.test/models",
    model: "test-deployment",
  }),
  isLlmAvailable: () => true,
}));

const model = "test-deployment";
const description = "Create an Express API";
const cases = [
  {
    name: "criterion authoring",
    request: buildCriteriaAuthoringRequest(description, ["build"], model),
    generate: () => generateCriteriaPrompt(description, [], ["build"], model),
    payload: {
      prompt: "Inspect captured build output.",
      suggestedId: "build_succeeds",
      suggestedParents: [],
      suggestedChildren: [],
    },
  },
  {
    name: "task generation",
    request: buildTaskPromptRequest({ description }, ["Create a CLI"], model),
    generate: () => generateTaskPrompt({ description }, ["Create a CLI"], model),
    payload: { taskPrompt: "Create an Express API with CRUD endpoints." },
  },
  {
    name: "task variation",
    request: buildTaskPromptRequest(
      { existingPrompt: description, description: "Use Python" }, [], model,
    ),
    generate: () => generateTaskPrompt(
      { existingPrompt: description, description: "Use Python" }, [], model,
    ),
    payload: { taskPrompt: "Create a Flask API with CRUD endpoints." },
  },
  {
    name: "prompt feature authoring",
    request: buildPromptFeatureAuthoringRequest(description, [], model),
    generate: () => generatePromptFeaturePrompt(description, [], model),
    payload: {
      prompt: "The task asks for an API.",
      suggestedId: "asks_for_api",
      suggestedParents: [],
      suggestedChildren: [],
    },
  },
  {
    name: "prompt feature extraction",
    request: buildPromptFeatureExtractionRequest(description, [], model),
    generate: () => extractPromptFeatures(description, [], model),
    payload: { results: [], suggestedFeatures: [] },
  },
];

beforeEach(() => {
  mockPost.mockReset();
  clearChatCompletionCompatibilityCache();
});

describe("production prompt builders with adaptive transport", () => {
  it.each(cases)("preserves $name requests during compatibility negotiation", async ({
    request,
    generate,
    payload,
  }) => {
    mockPost.mockResolvedValueOnce({
      status: "400",
      body: {
        error: {
          code: "unsupported_parameter",
          param: "max_completion_tokens",
        },
      },
    }).mockResolvedValue({
      status: "200",
      body: { choices: [{ message: { content: JSON.stringify(payload) } }] },
    });

    expect(await generate()).toEqual(payload);
    expect(await generate()).toEqual(payload);

    expect(mockPost).toHaveBeenCalledTimes(3);
    const { max_tokens, ...sharedFields } = request;
    expect(mockPost.mock.calls[0][0].body).toEqual({
      ...sharedFields,
      max_completion_tokens: max_tokens,
    });
    expect(mockPost.mock.calls[1][0].body).toEqual(request);
    expect(mockPost.mock.calls[2][0].body).toEqual(request);
  });
});
