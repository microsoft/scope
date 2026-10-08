// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearChatCompletionCompatibilityCache,
  postAdaptiveChatCompletion,
} from "./adaptive-chat-completions.js";
import type { ChatCompletionRequestBody } from "shared";

interface TestResponse {
  status: string;
  body: Record<string, unknown>;
}

const messages = [{ role: "user" as const, content: "ping" }];

function options(
  send: (body: ChatCompletionRequestBody) => Promise<TestResponse>,
  overrides: Partial<{ endpoint: string; model: string }> = {},
) {
  return {
    endpoint: overrides.endpoint ?? "https://example.test/models",
    model: overrides.model ?? "custom-deployment",
    messages,
    maxTokens: 32,
    temperature: 0.3,
    send,
  };
}

beforeEach(() => {
  clearChatCompletionCompatibilityCache();
});

describe("postAdaptiveChatCompletion", () => {
  it("uses the modern request shape without retry when accepted", async () => {
    const send = vi.fn(async () => ({
      status: "200",
      body: { choices: [] },
    }));

    await postAdaptiveChatCompletion(options(send));

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({
      max_completion_tokens: 32,
      temperature: 0.3,
    });
  });

  it("learns max_tokens from a structured compatibility error", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        status: "400",
        body: {
          error: {
            code: "unsupported_parameter",
            param: "max_completion_tokens",
          },
        },
      })
      .mockResolvedValue({
        status: "200",
        body: { choices: [] },
      });

    await postAdaptiveChatCompletion(options(send));
    await postAdaptiveChatCompletion(options(send));

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[1][0]).toHaveProperty("max_tokens", 32);
    expect(send.mock.calls[2][0]).toHaveProperty("max_tokens", 32);
  });

  it("can learn both a legacy token limit and omitted temperature", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        status: "400",
        body: {
          error: {
            code: "unsupported_parameter",
            param: "max_completion_tokens",
          },
        },
      })
      .mockResolvedValueOnce({
        status: "400",
        body: {
          error: {
            code: "unsupported_parameter",
            param: "temperature",
          },
        },
      })
      .mockResolvedValueOnce({
        status: "200",
        body: { choices: [] },
      });

    await postAdaptiveChatCompletion(options(send));

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2][0]).toEqual({
      messages,
      model: "custom-deployment",
      max_tokens: 32,
    });
  });

  it("does not retry unrelated errors", async () => {
    const send = vi.fn(async () => ({
      status: "401",
      body: { error: { code: "invalid_api_key" } },
    }));

    const response = await postAdaptiveChatCompletion(options(send));

    expect(response.status).toBe("401");
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not negotiate from compatibility-shaped server errors", async () => {
    const send = vi.fn(async () => ({
      status: "500",
      body: {
        error: {
          code: "unsupported_parameter",
          param: "max_completion_tokens",
        },
      },
    }));

    await postAdaptiveChatCompletion(options(send));

    expect(send).toHaveBeenCalledOnce();
  });

  it("negotiates from Model Inference 422 responses", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        status: "422",
        body: {
          code: "parameter_not_supported",
          detail: { loc: ["body", "temperature"] },
        },
      })
      .mockResolvedValueOnce({
        status: "200",
        body: { choices: [] },
      });

    await postAdaptiveChatCompletion(options(send));

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).not.toHaveProperty("temperature");
  });

  it("isolates learned compatibility by endpoint and model", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        status: "400",
        body: {
          error: {
            code: "unsupported_parameter",
            param: "max_completion_tokens",
          },
        },
      })
      .mockResolvedValue({
        status: "200",
        body: { choices: [] },
      });

    await postAdaptiveChatCompletion(options(send));
    await postAdaptiveChatCompletion(
      options(send, { model: "another-deployment" }),
    );

    expect(send.mock.calls[2][0]).toHaveProperty(
      "max_completion_tokens",
      32,
    );
  });

  it("single-flights cold compatibility negotiation", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let first = true;
    const send = vi.fn(async (body: ChatCompletionRequestBody) => {
      if (first) {
        first = false;
        await firstStarted;
        return {
          status: "400",
          body: {
            error: {
              code: "unsupported_parameter",
              param: "max_completion_tokens",
            },
          },
        };
      }
      return { status: "200", body: { choices: [] } };
    });

    const requestA = postAdaptiveChatCompletion(options(send));
    const requestB = postAdaptiveChatCompletion(options(send));
    await Promise.resolve();
    releaseFirst?.();
    await Promise.all([requestA, requestB]);

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[1][0]).toHaveProperty("max_tokens", 32);
    expect(send.mock.calls[2][0]).toHaveProperty("max_tokens", 32);
  });

  it("corrects a stale cached shape after Azure changes compatibility", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        status: "200",
        body: { choices: [] },
      })
      .mockResolvedValueOnce({
        status: "400",
        body: {
          error: {
            code: "unsupported_parameter",
            param: "max_completion_tokens",
          },
        },
      })
      .mockResolvedValueOnce({
        status: "200",
        body: { choices: [] },
      });

    await postAdaptiveChatCompletion(options(send));
    await postAdaptiveChatCompletion(options(send));

    expect(send.mock.calls[2][0]).toHaveProperty("max_tokens", 32);
  });

  it("evicts the least recently used entry after 100 endpoint-model keys", async () => {
    const legacySend = vi
      .fn()
      .mockResolvedValueOnce({
        status: "400",
        body: {
          error: {
            code: "unsupported_parameter",
            param: "max_completion_tokens",
          },
        },
      })
      .mockResolvedValue({
        status: "200",
        body: { choices: [] },
      });
    await postAdaptiveChatCompletion(
      options(legacySend, { model: "oldest-model" }),
    );

    for (let index = 0; index < 100; index += 1) {
      await postAdaptiveChatCompletion(
        options(
          async () => ({ status: "200", body: { choices: [] } }),
          { model: `model-${index}` },
        ),
      );
    }

    const afterEviction = vi.fn(async () => ({
      status: "200",
      body: { choices: [] },
    }));
    await postAdaptiveChatCompletion(
      options(afterEviction, { model: "oldest-model" }),
    );

    expect(afterEviction.mock.calls[0][0]).toHaveProperty(
      "max_completion_tokens",
      32,
    );
  });
});
