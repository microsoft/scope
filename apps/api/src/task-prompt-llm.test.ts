// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @azure-rest/ai-inference (must come before llm-token mock because
// llm-token imports ModelClient from this package).
const mockPost = vi.fn();
vi.mock("@azure-rest/ai-inference", () => ({
  default: () => ({
    path: () => ({ post: mockPost }),
  }),
  isUnexpected: (resp: any) => resp.status !== "200",
}));

vi.mock("@azure/core-auth", () => ({
  AzureKeyCredential: vi.fn(),
}));

// Mock llm-token module — provides both the legacy GitHub Models helpers
// and the new shared acquireInferenceClient(). The task-prompt module now
// only calls acquireInferenceClient, but we keep the legacy exports so
// the rest of the module surface stays compatible.
vi.mock("./llm-token.js", () => ({
  isLlmAvailable: vi.fn(() => true),
  isGitHubModelsTokenAvailable: vi.fn(() => true),
  acquireGitHubModelsToken: vi.fn(async () => "fake-token"),
  acquireInferenceClient: vi.fn(async () => ({
    client: { path: () => ({ post: mockPost }) },
    endpoint: "https://test.example.com",
    source: "azure-ai-foundry",
  })),
}));

import { generateTaskPrompt, isTaskPromptLlmAvailable } from "./task-prompt-llm.js";
import { clearChatCompletionCompatibilityCache } from "./adaptive-chat-completions.js";

describe("task-prompt-llm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearChatCompletionCompatibilityCache();
  });

  describe("isTaskPromptLlmAvailable", () => {
    it("returns true when token is available", () => {
      expect(isTaskPromptLlmAvailable()).toBe(true);
    });
  });

  describe("generateTaskPrompt – from description", () => {
    it("generates a task prompt from a description", async () => {
      mockPost.mockResolvedValueOnce({
        status: "200",
        body: {
          choices: [{
            message: {
              content: JSON.stringify({
                taskPrompt: "Create a REST API with Express.js that manages a todo list with CRUD endpoints",
              }),
            },
          }],
        },
      });

      const result = await generateTaskPrompt(
        { description: "a todo list API" },
        ["Create a Hello World Express API"],
      );

      expect(result.taskPrompt).toBe(
        "Create a REST API with Express.js that manages a todo list with CRUD endpoints",
      );
      expect(mockPost).toHaveBeenCalledOnce();

      // Verify the user message contains existing prompts
      const callBody = mockPost.mock.calls[0][0].body;
      const userMsg = callBody.messages[1].content;
      expect(userMsg).toContain("EXISTING TASK PROMPTS");
      expect(userMsg).toContain("Create a Hello World Express API");
      expect(userMsg).toContain("a todo list API");
    });

    it("generates a random task prompt with no input (surprise me)", async () => {
      mockPost.mockResolvedValueOnce({
        status: "200",
        body: {
          choices: [{
            message: {
              content: JSON.stringify({
                taskPrompt: "Build a real-time chat application using WebSockets and Redis",
              }),
            },
          }],
        },
      });

      const result = await generateTaskPrompt(
        {},
        ["Create a Hello World Express API"],
      );

      expect(result.taskPrompt).toBe(
        "Build a real-time chat application using WebSockets and Redis",
      );

      // Verify the user message asks for a creative task
      const callBody = mockPost.mock.calls[0][0].body;
      const userMsg = callBody.messages[1].content;
      expect(userMsg).toContain("creative and interesting");
      expect(userMsg).not.toContain("DESCRIPTION:");
    });
  });

  describe("generateTaskPrompt – variation", () => {
    it("generates a variation of an existing prompt", async () => {
      mockPost.mockResolvedValueOnce({
        status: "200",
        body: {
          choices: [{
            message: {
              content: JSON.stringify({
                taskPrompt: "Create a Python Flask REST API that manages a todo list",
              }),
            },
          }],
        },
      });

      const result = await generateTaskPrompt({
        existingPrompt: "Create a Node.js Express REST API that manages a todo list",
        description: "use Python instead",
      });

      expect(result.taskPrompt).toBe(
        "Create a Python Flask REST API that manages a todo list",
      );

      // Verify variation system prompt is used
      const callBody = mockPost.mock.calls[0][0].body;
      const systemMsg = callBody.messages[0].content;
      expect(systemMsg).toContain("variation");

      // Verify user message contains both existing prompt and guidance
      const userMsg = callBody.messages[1].content;
      expect(userMsg).toContain("EXISTING TASK PROMPT");
      expect(userMsg).toContain("Node.js Express");
      expect(userMsg).toContain("VARIATION GUIDANCE");
      expect(userMsg).toContain("use Python instead");
    });

    it("generates a variation without guidance", async () => {
      mockPost.mockResolvedValueOnce({
        status: "200",
        body: {
          choices: [{
            message: {
              content: JSON.stringify({
                taskPrompt: "Build a REST API using Fastify that manages a book collection",
              }),
            },
          }],
        },
      });

      const result = await generateTaskPrompt({
        existingPrompt: "Create a Node.js Express REST API that manages a todo list",
      });

      expect(result.taskPrompt).toBe(
        "Build a REST API using Fastify that manages a book collection",
      );

      const callBody = mockPost.mock.calls[0][0].body;
      const userMsg = callBody.messages[1].content;
      expect(userMsg).not.toContain("VARIATION GUIDANCE");
    });
  });

  describe("generateTaskPrompt – error handling", () => {
    it("throws on LLM error response", async () => {
      mockPost.mockResolvedValueOnce({
        status: "429",
        body: { error: { message: "Rate limit exceeded" } },
      });

      await expect(
        generateTaskPrompt({ description: "an API" }),
      ).rejects.toThrow("Rate limit exceeded");
    });

    it("throws on empty LLM response", async () => {
      mockPost.mockResolvedValueOnce({
        status: "200",
        body: { choices: [{ message: { content: "" } }] },
      });

      await expect(
        generateTaskPrompt({ description: "an API" }),
      ).rejects.toThrow("LLM returned empty response");
    });

    it("handles response with markdown fences", async () => {
      mockPost.mockResolvedValueOnce({
        status: "200",
        body: {
          choices: [{
            message: {
              content: '```json\n{"taskPrompt": "Build a CLI tool"}\n```',
            },
          }],
        },
      });

      const result = await generateTaskPrompt({ description: "a CLI" });
      expect(result.taskPrompt).toBe("Build a CLI tool");
    });

    it("falls back to raw text when response is not JSON", async () => {
      mockPost.mockResolvedValueOnce({
        status: "200",
        body: {
          choices: [{
            message: {
              content: "Create a full-stack React app with Express backend and PostgreSQL database",
            },
          }],
        },
      });

      const result = await generateTaskPrompt({ description: "full stack app" });
      expect(result.taskPrompt).toBe(
        "Create a full-stack React app with Express backend and PostgreSQL database",
      );
    });
  });
});
