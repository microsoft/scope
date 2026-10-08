// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  buildChatCompletionRequestBody,
  DEFAULT_CHAT_COMPLETION_COMPATIBILITY,
  nextChatCompletionCompatibility,
  type ChatCompletionCompatibility,
  type ChatCompletionMessage,
  type ChatCompletionRequestBody,
} from "shared";

const MAX_CACHE_ENTRIES = 100;
const MAX_ATTEMPTS = 3;

interface ChatCompletionHttpResponse {
  status: string;
  body: unknown;
}

export interface AdaptiveChatCompletionOptions<
  TResponse extends ChatCompletionHttpResponse,
> {
  endpoint: string;
  model: string;
  messages: ChatCompletionMessage[];
  maxTokens: number;
  temperature?: number;
  send: (body: ChatCompletionRequestBody) => PromiseLike<TResponse>;
}

const compatibilityCache = new Map<string, ChatCompletionCompatibility>();
const negotiations = new Map<
  string,
  Promise<ChatCompletionCompatibility | undefined>
>();

function cacheKey(endpoint: string, model: string): string {
  const normalizedEndpoint = endpoint.trim().replace(/\/+$/, "");
  return `${normalizedEndpoint}\n${model.trim()}`;
}

function getCachedCompatibility(
  key: string,
): ChatCompletionCompatibility | undefined {
  const compatibility = compatibilityCache.get(key);
  if (!compatibility) return undefined;

  compatibilityCache.delete(key);
  compatibilityCache.set(key, compatibility);
  return compatibility;
}

function setCachedCompatibility(
  key: string,
  compatibility: ChatCompletionCompatibility,
): void {
  compatibilityCache.delete(key);
  compatibilityCache.set(key, compatibility);

  while (compatibilityCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = compatibilityCache.keys().next().value;
    if (oldestKey === undefined) break;
    compatibilityCache.delete(oldestKey);
  }
}

function isSuccess(response: ChatCompletionHttpResponse): boolean {
  return response.status === "200";
}

function nextCompatibility(
  current: ChatCompletionCompatibility,
  response: ChatCompletionHttpResponse,
): ChatCompletionCompatibility | undefined {
  return response.status === "400" || response.status === "422"
    ? nextChatCompletionCompatibility(current, response.body)
    : undefined;
}

async function sendWithCompatibility<TResponse extends ChatCompletionHttpResponse>(
  options: AdaptiveChatCompletionOptions<TResponse>,
  compatibility: ChatCompletionCompatibility,
): Promise<TResponse> {
  return await options.send(
    buildChatCompletionRequestBody({
      messages: options.messages,
      model: options.model,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      compatibility,
    }),
  );
}

async function negotiate<TResponse extends ChatCompletionHttpResponse>(
  key: string,
  options: AdaptiveChatCompletionOptions<TResponse>,
  initialCompatibility: ChatCompletionCompatibility,
  maxAttempts: number,
): Promise<TResponse> {
  const existingNegotiation = negotiations.get(key);
  if (existingNegotiation) {
    const learned = await existingNegotiation;
    return sendWithCompatibility(
      options,
      learned ?? initialCompatibility,
    );
  }

  let resolveNegotiation!: (
    compatibility: ChatCompletionCompatibility | undefined,
  ) => void;
  const negotiation = new Promise<ChatCompletionCompatibility | undefined>(
    (resolve) => {
      resolveNegotiation = resolve;
    },
  );
  negotiations.set(key, negotiation);

  let compatibility = initialCompatibility;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await sendWithCompatibility(options, compatibility);
      if (isSuccess(response)) {
        setCachedCompatibility(key, compatibility);
        resolveNegotiation(compatibility);
        return response;
      }

      const corrected = nextCompatibility(compatibility, response);
      if (!corrected || attempt === maxAttempts) {
        resolveNegotiation(undefined);
        return response;
      }

      compatibility = corrected;
      console.warn(
        `[adaptive-chat] retrying model=${options.model} tokenLimitParameter=${compatibility.tokenLimitParameter} includeTemperature=${compatibility.includeTemperature}`,
      );
    }

    throw new Error("Chat completion compatibility negotiation exhausted");
  } catch (error) {
    resolveNegotiation(undefined);
    throw error;
  } finally {
    negotiations.delete(key);
  }
}

/**
 * Sends a chat completion using a process-local, model-independent compatibility
 * cache. Only structured unsupported-parameter responses trigger negotiation.
 */
export async function postAdaptiveChatCompletion<
  TResponse extends ChatCompletionHttpResponse,
>(
  options: AdaptiveChatCompletionOptions<TResponse>,
): Promise<TResponse> {
  const key = cacheKey(options.endpoint, options.model);
  const cached = getCachedCompatibility(key);
  if (!cached) {
    return negotiate(
      key,
      options,
      DEFAULT_CHAT_COMPLETION_COMPATIBILITY,
      MAX_ATTEMPTS,
    );
  }

  const response = await sendWithCompatibility(options, cached);
  if (isSuccess(response)) return response;

  const corrected = nextCompatibility(cached, response);
  if (!corrected) return response;

  compatibilityCache.delete(key);
  return negotiate(key, options, corrected, MAX_ATTEMPTS - 1);
}

export function clearChatCompletionCompatibilityCache(): void {
  compatibilityCache.clear();
  negotiations.clear();
}
