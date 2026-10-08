// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ChatCompletionTokenLimitParameter =
  | "max_completion_tokens"
  | "max_tokens";

export interface ChatCompletionCompatibility {
  tokenLimitParameter: ChatCompletionTokenLimitParameter;
  includeTemperature: boolean;
}

export const DEFAULT_CHAT_COMPLETION_COMPATIBILITY: ChatCompletionCompatibility =
  {
    tokenLimitParameter: "max_completion_tokens",
    includeTemperature: true,
  };

interface ChatCompletionRequestBase {
  messages: ChatCompletionMessage[];
  model: string;
  temperature?: number;
}

export type ChatCompletionRequestBody =
  | (ChatCompletionRequestBase & {
      max_completion_tokens: number;
    })
  | (ChatCompletionRequestBase & {
      max_tokens: number;
    });

export function buildChatCompletionRequestBody(options: {
  messages: ChatCompletionMessage[];
  model: string;
  maxTokens: number;
  temperature?: number;
  compatibility: ChatCompletionCompatibility;
}): ChatCompletionRequestBody {
  const { messages, model, maxTokens, temperature, compatibility } = options;
  const base = {
    messages,
    model,
    ...(compatibility.includeTemperature && temperature !== undefined
      ? { temperature }
      : {}),
  };

  return compatibility.tokenLimitParameter === "max_completion_tokens"
    ? { ...base, max_completion_tokens: maxTokens }
    : { ...base, max_tokens: maxTokens };
}

interface CompatibilityError {
  code?: unknown;
  param?: unknown;
  detail?: unknown;
  details?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compatibilityErrorParameter(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;

  const nestedError = isRecord(body.error) ? body.error : undefined;
  const error: CompatibilityError = nestedError ?? body;
  const code = error.code;
  if (code !== "unsupported_parameter" && code !== "parameter_not_supported") {
    return undefined;
  }

  if (typeof error.param === "string") return error.param;

  const detail = isRecord(error.detail)
    ? error.detail
    : isRecord(error.details)
      ? error.details
      : undefined;
  const location = detail?.loc;
  return Array.isArray(location) && typeof location.at(-1) === "string"
    ? location.at(-1)
    : undefined;
}

/**
 * Returns the next request shape only for structured parameter-compatibility
 * errors. Other client and service errors must be surfaced without retrying.
 */
export function nextChatCompletionCompatibility(
  current: ChatCompletionCompatibility,
  responseBody: unknown,
): ChatCompletionCompatibility | undefined {
  const parameter = compatibilityErrorParameter(responseBody);

  if (
    parameter === "max_completion_tokens" &&
    current.tokenLimitParameter === "max_completion_tokens"
  ) {
    return { ...current, tokenLimitParameter: "max_tokens" };
  }

  if (
    parameter === "max_tokens" &&
    current.tokenLimitParameter === "max_tokens"
  ) {
    return { ...current, tokenLimitParameter: "max_completion_tokens" };
  }

  if (parameter === "temperature" && current.includeTemperature) {
    return { ...current, includeTemperature: false };
  }

  return undefined;
}
