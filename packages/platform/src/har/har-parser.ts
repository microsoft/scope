// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * HAR file parser and tool call extractor.
 *
 * Parses HAR (HTTP Archive) files produced by DevProxy and extracts
 * structured tool call data from Copilot API request/response bodies.
 *
 * The extraction logic mirrors SCOPE's packages/coder/utils/har.ts:
 * - Scans response bodies for assistant role messages containing tool_calls arrays
 * - Matches tool role messages by tool_call_id to attach responses
 * - Produces an array of ToolCall objects
 */

import { readFile, writeFile } from "node:fs/promises";
import type { HarFile, HarEntry, HarNameValue, ToolCall } from "./types.js";
import type { TokenUsage } from "@scope/core";

/**
 * Header names whose values must be redacted before HAR files are
 * persisted or served to clients.  Matching is case-insensitive.
 */
const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "x-github-token",
  "x-api-key",
  "api-key",
  "x-oauth-scopes",
  "x-accepted-oauth-scopes",
  "cookie",
  "set-cookie",
]);

const REDACTED = "[REDACTED]";

/**
 * Return a deep-copy of the HAR with sensitive header values replaced by
 * `[REDACTED]`.  The original object is never mutated.
 */
export function sanitizeHar(har: HarFile): HarFile {
  return {
    log: {
      ...har.log,
      entries: har.log.entries.map((entry) => ({
        ...entry,
        request: {
          ...entry.request,
          headers: redactHeaders(entry.request.headers),
        },
        response: {
          ...entry.response,
          headers: redactHeaders(entry.response.headers),
        },
      })),
    },
  };
}

function redactHeaders(headers: HarNameValue[]): HarNameValue[] {
  return headers.map((h) =>
    SENSITIVE_HEADERS.has(h.name.toLowerCase())
      ? { name: h.name, value: REDACTED }
      : h,
  );
}

/**
 * Read a HAR file, sanitize it, write it to `outPath`, and return
 * the sanitised HAR object.
 */
export async function sanitizeHarFile(
  inPath: string,
  outPath: string,
): Promise<HarFile> {
  const har = await parseHarFile(inPath);
  const sanitized = sanitizeHar(har);
  await writeFile(outPath, JSON.stringify(sanitized), "utf-8");
  return sanitized;
}

/**
 * Parse a HAR file from disk.
 */
export async function parseHarFile(filePath: string): Promise<HarFile> {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as HarFile;
}

/**
 * Extract tool calls from a parsed HAR file.
 *
 * Scans HTTP request/response bodies for tool calls in both:
 * - OpenAI-style chat completions (choices[].message.tool_calls)
 * - Anthropic Messages API (content[].type === "tool_use")
 */
export function extractToolCalls(har: HarFile): ToolCall[] {
  const toolCalls: Map<string, ToolCall> = new Map();
  const toolResponses: Map<string, string> = new Map();

  for (const entry of har.log.entries) {
    // Process response bodies for assistant messages with tool_calls
    const responseBody = getResponseBody(entry);
    if (responseBody) {
      extractToolCallsFromBody(responseBody, entry.startedDateTime, toolCalls);
      extractAnthropicToolCallsFromBody(responseBody, entry.startedDateTime, toolCalls);
    }

    // Process request bodies for tool role messages (responses to tool calls)
    const requestBody = getRequestBody(entry);
    if (requestBody) {
      extractToolResponsesFromBody(requestBody, toolResponses);
    }
  }

  // Match tool responses to their originating tool calls
  for (const [id, response] of toolResponses) {
    const toolCall = toolCalls.get(id);
    if (toolCall) {
      toolCall.response = response;
    }
  }

  return Array.from(toolCalls.values());
}

/**
 * Get the response body text from a HAR entry, handling base64 encoding.
 */
function getResponseBody(entry: HarEntry): string | null {
  const content = entry.response?.content;
  if (!content?.text) return null;

  if (content.encoding === "base64") {
    try {
      // Use globalThis.atob for browser+Node 16+ compatibility
      // (avoids Node-only Buffer dependency)
      return decodeURIComponent(
        Array.from(globalThis.atob(content.text), (c) =>
          "%" + c.charCodeAt(0).toString(16).padStart(2, "0")
        ).join("")
      );
    } catch {
      return null;
    }
  }
  return content.text;
}

/**
 * Get the request body text from a HAR entry.
 */
function getRequestBody(entry: HarEntry): string | null {
  return entry.request?.postData?.text ?? null;
}

/**
 * Extract tool_calls from response body.
 *
 * Handles both streaming (SSE) and non-streaming responses:
 * - Non-streaming: JSON with choices[].message.tool_calls
 * - Streaming: multiple `data: {...}` lines with choices[].delta.tool_calls
 */
function extractToolCallsFromBody(
  body: string,
  timestamp: string,
  toolCalls: Map<string, ToolCall>,
): void {
  // Try non-streaming format first
  try {
    const json = JSON.parse(body);
    processChoices(json, timestamp, toolCalls);
    return;
  } catch {
    // Not a single JSON object — try streaming
  }

  // Handle SSE streaming format (data: {...}\n)
  const lines = body.split("\n");
  // Accumulate partial tool call data for streaming
  const partialCalls: Map<string, { name: string; arguments: string }> = new Map();
  // Map SSE index → tool call id so continuation chunks (which only
  // carry `index`, not `id`) can find the right partial entry.
  const indexToId: Map<number, string> = new Map();
  // Auto-incrementing counter for initial chunks that lack an explicit index.
  let nextAutoIndex = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;

    try {
      const json = JSON.parse(trimmed.slice(6));
      const choices = json.choices;
      if (!Array.isArray(choices)) continue;

      for (const choice of choices) {
        const delta = choice.delta;
        if (!delta?.tool_calls) continue;

        for (const tc of delta.tool_calls) {
          if (tc.id) {
            // New tool call chunk with id — register both maps
            partialCalls.set(tc.id, {
              name: tc.function?.name || "",
              arguments: tc.function?.arguments || "",
            });
            // Use the explicit index if provided, otherwise assign
            // the next auto-index so continuation chunks can match.
            const idx = tc.index ?? nextAutoIndex;
            indexToId.set(idx, tc.id);
            nextAutoIndex = idx + 1;
          } else if (tc.index !== undefined) {
            // Continuation chunk — look up by SSE index
            const id = indexToId.get(tc.index);
            if (id) {
              const partial = partialCalls.get(id);
              if (partial && tc.function?.arguments) {
                partial.arguments += tc.function.arguments;
              }
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  // Convert accumulated partial calls to ToolCall objects
  for (const [id, partial] of partialCalls) {
    if (!toolCalls.has(id)) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(partial.arguments);
      } catch {
        parsedArgs = { _raw: partial.arguments };
      }

      toolCalls.set(id, {
        id,
        name: partial.name,
        arguments: parsedArgs,
        timestamp,
      });
    }
  }
}

/**
 * Process choices array from a non-streaming response.
 */
function processChoices(
  json: Record<string, unknown>,
  timestamp: string,
  toolCalls: Map<string, ToolCall>,
): void {
  const choices = json.choices;
  if (!Array.isArray(choices)) return;

  for (const choice of choices) {
    const message = (choice as Record<string, unknown>).message as Record<string, unknown> | undefined;
    if (!message) continue;

    const tcArray = message.tool_calls;
    if (!Array.isArray(tcArray)) continue;

    for (const tc of tcArray) {
      const tcObj = tc as Record<string, unknown>;
      const id = tcObj.id as string;
      if (!id || toolCalls.has(id)) continue;

      const fn = tcObj.function as Record<string, unknown> | undefined;
      let parsedArgs: Record<string, unknown> = {};
      if (fn?.arguments) {
        try {
          parsedArgs = JSON.parse(fn.arguments as string);
        } catch {
          parsedArgs = { _raw: fn.arguments as string };
        }
      }

      toolCalls.set(id, {
        id,
        name: (fn?.name as string) || "unknown",
        arguments: parsedArgs,
        timestamp,
      });
    }
  }
}

/**
 * Extract tool_use blocks from Anthropic Messages API responses.
 *
 * Handles both non-streaming and streaming formats:
 * - Non-streaming: JSON with content[].type === "tool_use"
 * - Streaming: SSE events with content_block_start (tool_use) and
 *   content_block_delta (input_json_delta) for incremental input
 */
function extractAnthropicToolCallsFromBody(
  body: string,
  timestamp: string,
  toolCalls: Map<string, ToolCall>,
): void {
  // Try non-streaming format first
  try {
    const json = JSON.parse(body);
    if (Array.isArray(json.content)) {
      for (const block of json.content) {
        if (block.type === "tool_use" && block.id && !toolCalls.has(block.id)) {
          toolCalls.set(block.id, {
            id: block.id,
            name: block.name || "unknown",
            arguments: typeof block.input === "object" && block.input !== null
              ? block.input
              : {},
            timestamp,
          });
        }
      }
      return;
    }
  } catch {
    // Not a single JSON object — try streaming
  }

  // Handle Anthropic SSE streaming format
  // Events: content_block_start (type: tool_use), content_block_delta (type: input_json_delta)
  const lines = body.split("\n");
  const partialCalls: Map<number, { id: string; name: string; inputJson: string }> = new Map();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ")) continue;

    try {
      const json = JSON.parse(trimmed.slice(6));

      if (json.type === "content_block_start" && json.content_block?.type === "tool_use") {
        const idx = json.index ?? partialCalls.size;
        partialCalls.set(idx, {
          id: json.content_block.id || `anthropic-${idx}`,
          name: json.content_block.name || "unknown",
          inputJson: "",
        });
      }

      if (json.type === "content_block_delta" && json.delta?.type === "input_json_delta") {
        const idx = json.index ?? 0;
        const partial = partialCalls.get(idx);
        if (partial && typeof json.delta.partial_json === "string") {
          partial.inputJson += json.delta.partial_json;
        }
      }
    } catch {
      continue;
    }
  }

  // Convert accumulated partial calls to ToolCall objects
  for (const [, partial] of partialCalls) {
    if (!toolCalls.has(partial.id)) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(partial.inputJson);
      } catch {
        parsedArgs = partial.inputJson ? { _raw: partial.inputJson } : {};
      }
      toolCalls.set(partial.id, {
        id: partial.id,
        name: partial.name,
        arguments: parsedArgs,
        timestamp,
      });
    }
  }
}

/**
 * Extract tool role messages from request bodies.
 * These contain the responses to tool calls, matched by tool_call_id.
 *
 * Handles both OpenAI format (role: "tool", tool_call_id) and
 * Anthropic format (content[].type === "tool_result", tool_use_id).
 */
function extractToolResponsesFromBody(
  body: string,
  toolResponses: Map<string, string>,
): void {
  try {
    const json = JSON.parse(body);

    // OpenAI format: messages[].role === "tool"
    const messages = json.messages;
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        if (msg.role === "tool" && msg.tool_call_id && msg.content) {
          const content = typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content);
          toolResponses.set(msg.tool_call_id, content);
        }

        // Anthropic format: messages[].content[].type === "tool_result"
        if (msg.role === "user" && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "tool_result" && block.tool_use_id) {
              const content = typeof block.content === "string"
                ? block.content
                : block.content != null ? JSON.stringify(block.content) : "";
              toolResponses.set(block.tool_use_id, content);
            }
          }
        }
      }
    }
  } catch {
    // Not a valid JSON body — skip
  }
}

/**
 * Extract thinking/reasoning content from a parsed HAR file.
 *
 * Scans responses for thinking/reasoning content in both:
 * - OpenAI-style: SSE with choices[].delta.reasoning_text
 * - Anthropic non-streaming: content[].type === "thinking"
 * - Anthropic streaming: SSE content_block_delta with thinking delta
 */
export function extractThinkingContent(har: HarFile): string {
  const parts: string[] = [];

  for (const entry of har.log.entries) {
    const body = getResponseBody(entry);
    if (!body) continue;

    // Try non-streaming Anthropic format: content[].type === "thinking"
    try {
      const json = JSON.parse(body);
      if (Array.isArray(json.content)) {
        for (const block of json.content) {
          if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
            parts.push(block.thinking);
          }
        }
        continue;
      }
    } catch {
      // Not a single JSON object — try streaming
    }

    // Streaming formats (OpenAI SSE + Anthropic SSE)
    const lines = body.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;

      try {
        const json = JSON.parse(trimmed.slice(6));

        // OpenAI-style: choices[].delta.reasoning_text
        const choices = json.choices;
        if (Array.isArray(choices)) {
          for (const choice of choices) {
            const delta = choice.delta;
            if (!delta) continue;
            if (typeof delta.reasoning_text === "string" && delta.reasoning_text) {
              parts.push(delta.reasoning_text);
            }
            if (typeof delta.thinking === "string" && delta.thinking) {
              parts.push(delta.thinking);
            }
          }
        }

        // Anthropic streaming: content_block_delta with thinking type
        if (json.type === "content_block_delta" && json.delta?.type === "thinking_delta") {
          if (typeof json.delta.thinking === "string" && json.delta.thinking) {
            parts.push(json.delta.thinking);
          }
        }
      } catch {
        continue;
      }
    }
  }

  return parts.join("");
}

/**
 * Extract LLM token usage from a parsed HAR file.
 *
 * Scans response bodies for `usage` objects containing token counts
 * (OpenAI / GitHub Models format: prompt_tokens, completion_tokens, total_tokens;
 *  Anthropic format: input_tokens, output_tokens).
 *
 * Sums usage across all matching responses in the HAR.
 * Returns undefined if no token usage data is found.
 */
export function extractTokenUsage(har: HarFile): TokenUsage | undefined {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let found = false;

  for (const entry of har.log.entries) {
    const body = getResponseBody(entry);
    if (!body) continue;

    // Try non-streaming JSON response first
    try {
      const json = JSON.parse(body);
      if (accumulateUsage(json)) {
        found = true;
      }
      continue;
    } catch {
      // Not a single JSON object — try SSE streaming
    }

    // SSE streaming: look for the final chunk which typically carries usage
    const lines = body.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;
      try {
        const json = JSON.parse(trimmed.slice(6));
        if (accumulateUsage(json)) {
          found = true;
        }
      } catch {
        continue;
      }
    }
  }

  if (!found) return undefined;

  return { promptTokens, completionTokens, totalTokens };

  function accumulateUsage(json: Record<string, unknown>): boolean {
    const usage = json.usage as Record<string, unknown> | undefined;
    if (!usage || typeof usage !== "object") return false;

    // OpenAI / GitHub Models format
    if (typeof usage.prompt_tokens === "number") {
      promptTokens += usage.prompt_tokens;
      completionTokens += (usage.completion_tokens as number) ?? 0;
      totalTokens += (usage.total_tokens as number) ?? (usage.prompt_tokens + ((usage.completion_tokens as number) ?? 0));
      return true;
    }

    // Anthropic format
    if (typeof usage.input_tokens === "number") {
      promptTokens += usage.input_tokens;
      completionTokens += (usage.output_tokens as number) ?? 0;
      totalTokens += usage.input_tokens + ((usage.output_tokens as number) ?? 0);
      return true;
    }

    return false;
  }
}

/**
 * Parse a HAR file from disk and extract token usage.
 * Convenience wrapper combining parseHarFile + extractTokenUsage.
 */
export async function extractTokenUsageFromFile(filePath: string): Promise<TokenUsage | undefined> {
  const har = await parseHarFile(filePath);
  return extractTokenUsage(har);
}

/**
 * URL patterns that identify AI completion endpoints.
 * Matches the path suffix so it works across all known providers:
 * - GitHub Copilot:  https://api.githubcopilot.com/chat/completions
 * - GitHub Models:   https://models.inference.ai.azure.com/chat/completions
 * - Anthropic:       https://api.anthropic.com/v1/messages
 */
const AI_COMPLETION_URL_PATTERNS: ReadonlyArray<RegExp> = [
  /\/chat\/completions(\?|$)/,
  /\/v1\/messages(\?|$)/,
];

/**
 * Count the number of AI completion calls captured in a HAR file.
 *
 * Only POST requests with a 2xx response are counted:
 * - POST-only: excludes OPTIONS preflights and other methods
 * - 2xx-only: excludes 429 retries and transient 5xx errors so the
 *   count reflects successful agent interactions, not noise
 * - URL pattern uses (\?|$) to match paths with or without query params
 *   (e.g. Azure OpenAI appends ?api-version=...)
 */
export function extractAiCallCount(har: HarFile): number {
  return har.log.entries.filter((entry) =>
    entry.request.method === "POST" &&
    entry.response.status >= 200 &&
    entry.response.status < 300 &&
    AI_COMPLETION_URL_PATTERNS.some((p) => p.test(entry.request.url)),
  ).length;
}
