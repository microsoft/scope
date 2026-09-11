// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(), settings: vi.fn(), legacy: vi.fn(), azurePost: vi.fn(), azure: vi.fn(),
}));
vi.mock("shared", async (original) => ({
  ...await original<typeof import("shared")>(),
  TokenManagerClient: class {
    acquirePortalToken = mocks.acquire;
    getPortalAiSettings = mocks.settings;
    acquireToken = mocks.legacy;
  },
}));
vi.mock("@azure-rest/ai-inference", () => ({
  default: mocks.azure.mockImplementation(() => ({ path: () => ({ post: mocks.azurePost }) })),
  isUnexpected: (response: { status: string }) => response.status !== "200",
}));
import { acquireInferenceClient } from "./llm-token.js";
import { generateTaskPrompt } from "./task-prompt-llm.js";
import { generateCriteriaPrompt } from "./llm.js";
import { generatePromptFeaturePrompt, extractPromptFeatures } from "./prompt-feature-llm.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TOKEN_MANAGER_URL", "http://token-manager.test");
  vi.stubEnv("AZURE_AI_INFERENCE_ENDPOINT", "");
  vi.stubEnv("AZURE_AI_INFERENCE_API_KEY", "");
  mocks.settings.mockResolvedValue({ provider: "auto" });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Portal provider selection and authoring", () => {
  it.each([
    ["openai", "openai-api-key", "openai-api", "https://api.openai.com/v1", "gpt-4.1"],
    ["openrouter", "openrouter-api-key", "openrouter-api", "https://openrouter.ai/api/v1", "openai/gpt-4.1"],
    ["openai-compatible", "openai-compatible", "openai-compatible", "https://provider.test/v1", "custom-model"],
  ] as const)("invokes %s from the persisted vault credential through task authoring", async (provider, keyType, capability, endpoint, model) => {
    mocks.settings.mockResolvedValue({ provider, keyId: "key-1" });
    mocks.acquire.mockResolvedValue({ keyType, value: JSON.stringify({ endpoint, model, apiKey: "test-key" }) });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"taskPrompt":"Create a todo API"}' } }],
    })));
    expect(await generateTaskPrompt({ description: "todo" })).toEqual({ taskPrompt: "Create a todo API" });
    expect(mocks.acquire).toHaveBeenCalledWith({ capability, keyType, keyId: "key-1", strictKeyType: true });
    expect(fetchSpy).toHaveBeenCalledWith(`${endpoint}/chat/completions`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
    }));
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as { model: string };
    expect(body.model).toBe(model);
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it("uses existing Anthropic raw keys with native Messages and a selected model", async () => {
    mocks.settings.mockResolvedValue({ provider: "anthropic", model: "claude-test" });
    mocks.acquire.mockResolvedValue({ keyType: "anthropic-api-key", value: "sk-ant-test" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: "thinking", thinking: "not output" }, { type: "text", text: '{"taskPrompt":"Build a CLI"}' }],
    })));
    expect(await generateTaskPrompt({})).toEqual({ taskPrompt: "Build a CLI" });
    expect(fetchSpy).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", expect.objectContaining({
      headers: expect.objectContaining({ "x-api-key": "sk-ant-test", "anthropic-version": "2023-06-01" }),
    }));
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as { model: string; system: string; messages: Array<{ role: string }> };
    expect(body.model).toBe("claude-test");
    expect(body.system).toContain("benchmark task prompts");
    expect(body.messages.every((message) => message.role !== "system")).toBe(true);
  });

  it("retains Foundry environment defaults in automatic mode", async () => {
    vi.stubEnv("AZURE_AI_INFERENCE_ENDPOINT", "https://scope.services.ai.azure.com");
    vi.stubEnv("AZURE_AI_INFERENCE_API_KEY", "foundry-test");
    const handle = await acquireInferenceClient();
    expect(handle.source).toBe("azure-ai-foundry");
    expect(handle.endpoint).toBe("https://scope.services.ai.azure.com/models");
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it.each(["gpt-5.4-mini", "o1", "o3-mini", "o4-mini"])("sends reasoning parameters through the existing Foundry Azure client for %s", async (model) => {
    const endpoint = "https://scope.services.ai.azure.com/models";
    mocks.acquire.mockResolvedValue({ keyType: "azure-ai-foundry", value: JSON.stringify({ endpoint, model, apiKey: "foundry-test" }) });
    mocks.azurePost.mockResolvedValue({ status: "200", body: { choices: [{ message: { content: "criterion text" } }] } });
    const handle = await acquireInferenceClient({ provider: "azure-ai-foundry", keyId: "foundry-key" });
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
    mocks.acquire.mockResolvedValue({ keyType: "azure-ai-foundry", value: JSON.stringify({ endpoint, model: "gpt-4.1", apiKey: "foundry-test" }) });
    mocks.azurePost.mockResolvedValue({ status: "200", body: { choices: [{ message: { content: "legacy criterion" } }] } });
    const handle = await acquireInferenceClient({ provider: "azure-ai-foundry" });
    const body = {
      model: "gpt-4.1", messages: [{ role: "user" as const, content: "Write a criterion" }], max_tokens: 512, temperature: 0.3,
    };
    await handle.client.path("/chat/completions").post({ body });
    expect(mocks.azure).toHaveBeenCalledWith(endpoint, expect.objectContaining({ key: "foundry-test" }));
    expect(mocks.azurePost).toHaveBeenCalledExactlyOnceWith({ body });
    expect(mocks.azurePost.mock.calls[0][0].body).toBe(body);
  });

  it("explicit Anthropic selection overrides Foundry env without changing any worker credential", async () => {
    vi.stubEnv("AZURE_AI_INFERENCE_ENDPOINT", "https://foundry.test/models");
    vi.stubEnv("AZURE_AI_INFERENCE_API_KEY", "foundry-test");
    mocks.acquire.mockResolvedValue({ value: "sk-ant-test", keyType: "anthropic-api-key" });
    expect(await acquireInferenceClient({ provider: "anthropic" })).toMatchObject({
      source: "anthropic", model: "claude-sonnet-5",
    });
    expect(mocks.azure).not.toHaveBeenCalled();
  });

  it("does not fail over when selected credentials cannot be acquired", async () => {
    mocks.acquire.mockRejectedValue(new Error("HTTP 404"));
    await expect(acquireInferenceClient({ provider: "openrouter" })).rejects.toThrow("no usable openrouter credential");
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it("preserves criterion, prompt-feature and extraction outputs on the new transport", async () => {
    mocks.settings.mockResolvedValue({ provider: "openai" });
    mocks.acquire.mockResolvedValue({ value: JSON.stringify({ endpoint: "https://api.openai.com/v1", apiKey: "test", model: "gpt-4.1" }) });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"prompt":"Detect tests","suggestedId":"has_tests"}' } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"prompt":"Detect React","suggestedId":"asks_react"}' } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"results":[{"featureId":"asks_react","detected":true}],"suggestedFeatures":[]}' } }] })));
    expect(await generateCriteriaPrompt("tests", [])).toMatchObject({ prompt: "Detect tests", suggestedId: "has_tests" });
    expect(await generatePromptFeaturePrompt("React", [])).toMatchObject({ prompt: "Detect React", suggestedId: "asks_react" });
    const result = await extractPromptFeatures("Create React", [{ id: "asks_react", prompt: "Detect React" }]);
    expect(result.results).toEqual([{ featureId: "asks_react", detected: true, evaluated: true }]);
  });
});
