// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireEndpoint: vi.fn(),
  acquireToken: vi.fn(),
  modelClient: vi.fn(() => ({ path: vi.fn() })),
  azureKeyCredential: vi.fn(function (this: any, key: string) {
    this.key = key;
  }),
}));

vi.mock("shared", () => ({
  TokenManagerClient: class {
    acquireEndpoint = mocks.acquireEndpoint;
    acquireToken = mocks.acquireToken;
  },
}));

vi.mock("@azure-rest/ai-inference", () => ({
  default: mocks.modelClient,
}));

vi.mock("@azure/core-auth", () => ({
  AzureKeyCredential: mocks.azureKeyCredential,
}));

import { acquireInferenceClient } from "./llm-token.js";

describe("acquireInferenceClient", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.AZURE_AI_INFERENCE_ENDPOINT;
    delete process.env.AZURE_AI_INFERENCE_API_KEY;
    delete process.env.GITHUB_MODELS_API_KEY;
    delete process.env.GITHUB_TOKEN;
    process.env.TOKEN_MANAGER_URL = "http://token-manager:3000";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses the Token Manager structured endpoint response", async () => {
    mocks.acquireEndpoint.mockResolvedValue({
      endpoint: "https://foundry.example.com/models",
      apiKey: "foundry-key",
      deployment: "gpt-4.1-mini",
    });

    const result = await acquireInferenceClient();

    expect(mocks.acquireEndpoint).toHaveBeenCalledWith("azure-ai-inference");
    expect(mocks.acquireToken).not.toHaveBeenCalledWith("azure-ai-inference");
    expect(mocks.azureKeyCredential).toHaveBeenCalledWith("foundry-key");
    expect(mocks.modelClient).toHaveBeenCalledWith(
      "https://foundry.example.com/models",
      expect.anything()
    );
    expect(result).toMatchObject({
      endpoint: "https://foundry.example.com/models",
      source: "azure-ai-foundry",
      via: "azure-ai-foundry-token-manager",
      model: "gpt-4.1-mini",
    });
  });
});
