// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireToken: vi.fn(),
  copilotComplete: vi.fn(),
  modelClient: vi.fn(),
  modelPost: vi.fn(),
  parseFoundrySecret: vi.fn(),
}));

vi.mock("@azure-rest/ai-inference", () => ({
  default: mocks.modelClient,
  isUnexpected: (response: { status: string }) => response.status !== "200",
}));

vi.mock("@azure/core-auth", () => ({
  AzureKeyCredential: class {
    constructor(readonly key: string) {}
  },
}));

vi.mock("shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("shared")>();
  return {
    ...actual,
    TokenManagerClient: class {
      acquireToken = mocks.acquireToken;
    },
    parseAzureAiFoundrySecret: mocks.parseFoundrySecret,
  };
});

vi.mock("./copilot-client-pool.js", () => {
  class CopilotCredentialUnavailableError extends Error {}
  return {
    CopilotCredentialUnavailableError,
    getPortalCopilotClientPool: () => ({ complete: mocks.copilotComplete }),
  };
});

import {
  completePortalLlm,
  type PortalLlmCompletionRequest,
} from "./llm-token.js";
import { CopilotCredentialUnavailableError } from "./copilot-client-pool.js";

const request: PortalLlmCompletionRequest = {
  messages: [
    { role: "system", content: "system" },
    { role: "user", content: "user" },
  ],
  model: "request-model",
  temperature: 0.2,
  max_tokens: 128,
};

function completion(content: string) {
  return {
    status: "200",
    body: { choices: [{ message: { content } }] },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const name of [
    "AZURE_AI_INFERENCE_ENDPOINT",
    "AZURE_AI_INFERENCE_API_KEY",
    "TOKEN_MANAGER_URL",
    "GITHUB_MODELS_API_KEY",
    "GITHUB_TOKEN",
    "LLM_MODEL",
  ]) {
    vi.stubEnv(name, "");
  }
  mocks.modelClient.mockReturnValue({
    path: () => ({ post: mocks.modelPost }),
  });
  mocks.parseFoundrySecret.mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("completePortalLlm provider resolution", () => {
  it("prefers an explicit Foundry configuration over Copilot and GitHub Models", async () => {
    vi.stubEnv("AZURE_AI_INFERENCE_ENDPOINT", "https://foundry.services.ai.azure.com");
    vi.stubEnv("AZURE_AI_INFERENCE_API_KEY", "foundry-key");
    vi.stubEnv("GITHUB_TOKEN", "github-token");
    mocks.modelPost.mockResolvedValue(completion("from-foundry"));

    await expect(completePortalLlm(request, "explicit-model")).resolves.toBe("from-foundry");

    expect(mocks.modelClient).toHaveBeenCalledWith(
      "https://foundry.services.ai.azure.com/models",
      expect.objectContaining({ key: "foundry-key" }),
    );
    expect(mocks.modelPost).toHaveBeenCalledWith({
      body: expect.objectContaining({ model: "explicit-model" }),
    });
    expect(mocks.copilotComplete).not.toHaveBeenCalled();
  });

  it("uses a Token Manager Foundry credential before Copilot", async () => {
    vi.stubEnv("TOKEN_MANAGER_URL", "https://tokens.example.test");
    vi.stubEnv("GITHUB_TOKEN", "github-token");
    mocks.acquireToken.mockResolvedValueOnce("serialized-foundry-secret");
    mocks.parseFoundrySecret.mockReturnValue({
      endpoint: "https://managed-foundry.example.test/models",
      apiKey: "managed-key",
      model: "managed-model",
    });
    mocks.modelPost.mockResolvedValue(completion("from-managed-foundry"));

    await expect(completePortalLlm(request)).resolves.toBe("from-managed-foundry");

    expect(mocks.acquireToken).toHaveBeenCalledWith("azure-ai-inference");
    expect(mocks.modelPost).toHaveBeenCalledWith({
      body: expect.objectContaining({ model: "managed-model" }),
    });
    expect(mocks.copilotComplete).not.toHaveBeenCalled();
  });

  it("falls back to the Copilot SDK when Foundry credentials are unavailable", async () => {
    vi.stubEnv("GITHUB_TOKEN", "github-token");
    mocks.copilotComplete.mockResolvedValue("from-copilot");

    await expect(completePortalLlm(request, "copilot-model")).resolves.toBe("from-copilot");

    expect(mocks.copilotComplete).toHaveBeenCalledWith({
      systemPrompt: "system",
      userPrompt: "user",
      model: "copilot-model",
    });
    expect(mocks.modelPost).not.toHaveBeenCalled();
  });

  it("falls back to GitHub Models only when Copilot has no usable credential", async () => {
    vi.stubEnv("TOKEN_MANAGER_URL", "https://tokens.example.test");
    mocks.acquireToken
      .mockRejectedValueOnce(new Error("no Foundry key"))
      .mockResolvedValueOnce("github-models-key");
    mocks.copilotComplete.mockRejectedValue(
      new CopilotCredentialUnavailableError("no Copilot credential"),
    );
    mocks.modelPost.mockResolvedValue(completion("from-github-models"));

    await expect(completePortalLlm(request)).resolves.toBe("from-github-models");

    expect(mocks.copilotComplete).toHaveBeenCalledOnce();
    expect(mocks.acquireToken).toHaveBeenNthCalledWith(2, "github-models");
    expect(mocks.modelPost).toHaveBeenCalledOnce();
  });

  it("uses an explicit GitHub Models key when no Copilot credential is configured", async () => {
    vi.stubEnv("GITHUB_MODELS_API_KEY", "github-models-key");
    mocks.modelPost.mockResolvedValue(completion("from-github-models-env"));

    await expect(completePortalLlm(request)).resolves.toBe(
      "from-github-models-env",
    );

    expect(mocks.copilotComplete).not.toHaveBeenCalled();
    expect(mocks.modelPost).toHaveBeenCalledOnce();
  });

  it("does not hide an inference failure by falling through to another provider", async () => {
    vi.stubEnv("AZURE_AI_INFERENCE_ENDPOINT", "https://foundry.example.test/models");
    vi.stubEnv("AZURE_AI_INFERENCE_API_KEY", "foundry-key");
    vi.stubEnv("GITHUB_TOKEN", "github-token");
    mocks.modelPost.mockResolvedValue({
      status: "500",
      body: { error: { message: "Foundry unavailable" } },
    });

    await expect(completePortalLlm(request)).rejects.toThrow(
      "LLM request failed: Foundry unavailable",
    );
    expect(mocks.copilotComplete).not.toHaveBeenCalled();
  });
});
