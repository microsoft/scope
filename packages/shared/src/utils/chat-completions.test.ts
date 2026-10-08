// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  buildChatCompletionRequestBody,
  DEFAULT_CHAT_COMPLETION_COMPATIBILITY,
  nextChatCompletionCompatibility,
} from "./chat-completions.js";

const messages = [{ role: "user" as const, content: "ping" }];

describe("chat completion request bodies", () => {
  it("uses modern token limits and temperature by default", () => {
    expect(
      buildChatCompletionRequestBody({
        messages,
        model: "custom-deployment",
        maxTokens: 512,
        temperature: 0.3,
        compatibility: DEFAULT_CHAT_COMPLETION_COMPATIBILITY,
      }),
    ).toEqual({
      messages,
      model: "custom-deployment",
      max_completion_tokens: 512,
      temperature: 0.3,
    });
  });

  it("builds a learned legacy request without temperature", () => {
    expect(
      buildChatCompletionRequestBody({
        messages,
        model: "custom-deployment",
        maxTokens: 512,
        temperature: 0.3,
        compatibility: {
          tokenLimitParameter: "max_tokens",
          includeTemperature: false,
        },
      }),
    ).toEqual({
      messages,
      model: "custom-deployment",
      max_tokens: 512,
    });
  });
});

describe("chat completion compatibility transitions", () => {
  it("switches token-limit parameters from structured Azure errors", () => {
    expect(
      nextChatCompletionCompatibility(
        DEFAULT_CHAT_COMPLETION_COMPATIBILITY,
        {
          error: {
            code: "unsupported_parameter",
            param: "max_completion_tokens",
          },
        },
      ),
    ).toEqual({
      tokenLimitParameter: "max_tokens",
      includeTemperature: true,
    });
  });

  it("switches rejected legacy token limits back to modern token limits", () => {
    expect(
      nextChatCompletionCompatibility(
        {
          tokenLimitParameter: "max_tokens",
          includeTemperature: true,
        },
        {
          error: {
            code: "unsupported_parameter",
            param: "max_tokens",
          },
        },
      ),
    ).toEqual({
      tokenLimitParameter: "max_completion_tokens",
      includeTemperature: true,
    });
  });

  it("removes temperature from Model Inference structured errors", () => {
    expect(
      nextChatCompletionCompatibility(
        DEFAULT_CHAT_COMPLETION_COMPATIBILITY,
        {
          code: "parameter_not_supported",
          detail: { loc: ["body", "temperature"] },
        },
      ),
    ).toEqual({
      tokenLimitParameter: "max_completion_tokens",
      includeTemperature: false,
    });
  });

  it("does not retry unrelated or unstructured errors", () => {
    expect(
      nextChatCompletionCompatibility(
        DEFAULT_CHAT_COMPLETION_COMPATIBILITY,
        { error: { code: "invalid_request_error", param: "messages" } },
      ),
    ).toBeUndefined();
    expect(
      nextChatCompletionCompatibility(
        DEFAULT_CHAT_COMPLETION_COMPATIBILITY,
        { error: { message: "max_completion_tokens is unsupported" } },
      ),
    ).toBeUndefined();
  });
});
