// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { withRetry, type PortalAiProvider } from "shared";

export interface PortalChatBody {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model: string;
  temperature?: number;
  max_tokens?: number;
}

export interface PortalChatResponse {
  status: string;
  body: {
    choices?: Array<{ message: { content?: string | null } }>;
    error?: { message?: string };
  };
}

export interface PortalChatClient {
  path(path: "/chat/completions"): {
    post(request: { body: PortalChatBody }): Promise<PortalChatResponse>;
  };
}

class ProviderHttpError extends Error {
  constructor(readonly status: number) {
    super(`LLM request failed: provider returned HTTP ${status}`);
  }
}

/** The authoring helpers share text-only chat; Anthropic uses its native Messages protocol. */
export function createPortalChatClient(
  provider: PortalAiProvider,
  endpoint: string,
  apiKey: string,
): PortalChatClient {
  return {
    path: () => ({
      post: async ({ body }) => {
        const anthropic = provider === "anthropic";
        const reasoning = provider === "openai" && /^(gpt-5|o[134])(?:[.-]|$)/.test(body.model);
        const requestBody = anthropic ? {
          model: body.model,
          system: body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n"),
          messages: body.messages.filter((m) => m.role !== "system"),
          max_tokens: body.max_tokens ?? 1024,
          ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        } : reasoning ? {
          model: body.model, messages: body.messages, max_completion_tokens: body.max_tokens,
        } : body;
        let retryNotBefore = 0;
        const data = await withRetry(async () => {
          const waitMs = retryNotBefore - Date.now();
          if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
          const response = await fetch(`${endpoint}/${anthropic ? "messages" : "chat/completions"}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(anthropic
                ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
                : { Authorization: `Bearer ${apiKey}` }),
            },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(60_000),
            redirect: "error",
          });
          if (!response.ok) {
            const retryAfter = response.headers.get("retry-after");
            const seconds = retryAfter === null ? NaN : Number(retryAfter);
            const retryDelay = Number.isFinite(seconds) ? seconds * 1000
              : retryAfter ? Date.parse(retryAfter) - Date.now() : 0;
            retryNotBefore = Date.now() + Math.max(0, Math.min(30_000, retryDelay || 0));
            throw new ProviderHttpError(response.status);
          }
          const result: unknown = await response.json();
          return result;
        }, {
          maxRetries: 3, baseDelayMs: 500, maxDelayMs: 30_000,
          isRetryable: (err) => !(err instanceof SyntaxError) &&
            (!(err instanceof ProviderHttpError) || err.status === 429 || err.status >= 500),
        }).catch((err: unknown) => {
          if (err instanceof ProviderHttpError) throw err;
          throw new Error("LLM request failed: provider unavailable or returned invalid JSON");
        });
        if (!data || typeof data !== "object") throw new Error("LLM request failed: invalid provider response");
        if (anthropic) {
          if (!("content" in data) || !Array.isArray(data.content)) throw new Error("LLM request failed: invalid Anthropic response");
          const text = data.content
            .filter((part: unknown): part is { type: "text"; text: string } => !!part && typeof part === "object" &&
              "type" in part && part.type === "text" && "text" in part && typeof part.text === "string")
            .map((part) => part.text).join("");
          return { status: "200", body: { choices: [{ message: { content: text } }] } };
        }
        if (!("choices" in data) || !Array.isArray(data.choices)) throw new Error("LLM request failed: invalid chat-completions response");
        const first: unknown = data.choices[0];
        if (!first || typeof first !== "object" || !("message" in first) || !first.message ||
          typeof first.message !== "object" || !("content" in first.message) ||
          typeof first.message.content !== "string") {
          throw new Error("LLM request failed: provider returned no text");
        }
        return { status: "200", body: { choices: [{ message: { content: first.message.content } }] } };
      },
    }),
  };
}
