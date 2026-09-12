// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireToken: vi.fn(),
  azurePost: vi.fn(),
  azure: vi.fn(),
}));

vi.mock("shared", async (original) => ({
  ...await original<typeof import("shared")>(),
  TokenManagerClient: class {
    acquireToken = mocks.acquireToken;
  },
}));

vi.mock("@azure-rest/ai-inference", () => ({
  default: mocks.azure.mockImplementation(() => ({ path: () => ({ post: mocks.azurePost }) })),
}));

import { acquireInferenceClient, normalizeOpenAiChatBody } from "./llm-token.js";

const body = {
  model: "gpt-4.1",
  messages: [{ role: "user" as const, content: "Hello" }],
  max_tokens: 512,
  temperature: 0.3,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TOKEN_MANAGER_URL", "http://token-manager.test");
  vi.stubEnv("AZURE_AI_INFERENCE_ENDPOINT", "");
  vi.stubEnv("AZURE_AI_INFERENCE_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("acquireInferenceClient", () => {
  it("retains Foundry environment defaults", async () => {
    vi.stubEnv("AZURE_AI_INFERENCE_ENDPOINT", "https://scope.services.ai.azure.com");
    vi.stubEnv("AZURE_AI_INFERENCE_API_KEY", "foundry-test");

    const handle = await acquireInferenceClient();

    expect(handle.source).toBe("azure-ai-foundry");
    expect(handle.via).toBe("azure-ai-foundry-env");
    expect(handle.endpoint).toBe("https://scope.services.ai.azure.com/models");
    expect(mocks.acquireToken).not.toHaveBeenCalled();
  });

  it.each(["gpt-5.4-mini", "o1", "o3-mini", "o4-mini"])("normalizes reasoning parameters on the Foundry Azure client for %s", async (model) => {
    const endpoint = "https://scope.services.ai.azure.com/models";
    mocks.acquireToken.mockResolvedValue(JSON.stringify({ endpoint, model, apiKey: "foundry-test" }));
    mocks.azurePost.mockResolvedValue({ status: "200", body: { choices: [{ message: { content: "criterion text" } }] } });

    const handle = await acquireInferenceClient();
    const messages = [{ role: "user" as const, content: "Write a hello.js criterion" }];
    const response = await handle.client.path("/chat/completions").post({
      body: { model, messages, max_tokens: 512, temperature: 0.3 },
    });

    expect(mocks.azure).toHaveBeenCalledWith(endpoint, expect.objectContaining({ key: "foundry-test" }));
    expect(mocks.azurePost).toHaveBeenCalledExactlyOnceWith({
      body: { model, messages, max_completion_tokens: 512 },
    });
    expect(response.body.choices?.[0].message.content).toBe("criterion text");
  });

  it("preserves the legacy Foundry gpt-4.1 request shape and Azure authentication", async () => {
    const endpoint = "https://scope.services.ai.azure.com/models";
    mocks.acquireToken.mockResolvedValue(JSON.stringify({ endpoint, model: "gpt-4.1", apiKey: "foundry-test" }));
    mocks.azurePost.mockResolvedValue({ status: "200", body: { choices: [{ message: { content: "legacy criterion" } }] } });

    const handle = await acquireInferenceClient();
    await handle.client.path("/chat/completions").post({ body });

    expect(mocks.azure).toHaveBeenCalledWith(endpoint, expect.objectContaining({ key: "foundry-test" }));
    expect(mocks.azurePost).toHaveBeenCalledExactlyOnceWith({ body });
    expect(mocks.azurePost.mock.calls[0][0].body).toBe(body);
  });
});

describe("normalizeOpenAiChatBody", () => {
  it.each(["gpt-5", "gpt-5.4-mini", "o1", "o1-preview", "o3-mini", "o4-mini"])("normalizes recognized model %s without mutating the input", (model) => {
    const original = { ...body, model };

    expect(normalizeOpenAiChatBody(original)).toEqual({
      model,
      messages: body.messages,
      max_completion_tokens: 512,
    });
    expect(original).toEqual({ ...body, model });
  });

  it.each(["gpt-4.1", "gpt-50", "custom-deployment"])("preserves the complete legacy request for %s", (model) => {
    const original = { ...body, model };

    expect(normalizeOpenAiChatBody(original)).toBe(original);
  });
});
