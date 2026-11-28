// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * HAR file parser and tool call extractor.
 *
 * Parses HAR (HTTP Archive) files produced by DevProxy (HTTP-only) and the
 * gateway (which additionally captures WebSocket frames) and extracts structured
 * tool call data from Copilot API request/response payloads.
 *
 * Three wire formats are supported:
 * - OpenAI chat-completions (`/chat/completions`): assistant `tool_calls`
 *   in responses, `role: "tool"` results in requests.
 * - Anthropic Messages (`/v1/messages`): `content[].type === "tool_use"`
 *   in responses, `tool_result` blocks in requests.
 * - OpenAI Responses API (`/responses`, used by gpt-5.x via Copilot): tool
 *   calls arrive as `function_call` / `custom_tool_call` items — both in
 *   response `response.output_item.done` SSE events and in the accumulated
 *   request `input[]` transcript — with results as
 *   `function_call_output` / `custom_tool_call_output` items in `input[]`,
 *   all keyed by `call_id`. (Extractors live in `responses-api-parser.ts`.)
 *
 * Across two transports:
 * - HTTP bodies (`entry.request.postData.text` / `entry.response.content.text`),
 *   as produced by DevProxy.
 * - WebSocket frames (`entry._webSocketMessages`), when the Copilot CLI carries
 *   the Responses API over a WebSocket (gateway-captured). The frames are
 *   unwrapped and fed to the same Responses-API extractors — see
 *   `extractResponsesApiFromWebSocketMessages` in `responses-api-parser.ts`.
 *
 * Calls and results are matched by id to produce an array of ToolCall objects.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { HarFile, HarEntry, HarNameValue, ToolCall } from "./types.js";
import type { TokenUsage } from "../types/types.js";
import {
  extractResponsesApiToolCallsFromBody,
  extractResponsesApiFromRequestBody,
  extractResponsesApiFromWebSocketMessages,
} from "./responses-api-parser.js";
import { parseBody, tryParseJson, type ParsedBody } from "./parsed-body.js";

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
 * Scans both HTTP request/response bodies and captured WebSocket frames for
 * tool calls in:
 * - OpenAI chat completions (choices[].message.tool_calls)
 * - Anthropic Messages API (content[].type === "tool_use")
 * - OpenAI Responses API (function_call / custom_tool_call items, in both
 *   response `output_item.done` events and the request `input[]` transcript) —
 *   over HTTP bodies *and* over WebSocket `_webSocketMessages` frames.
 */
export function extractToolCalls(har: HarFile): ToolCall[] {
  const toolCalls: Map<string, ToolCall> = new Map();
  const toolResponses: Map<string, string> = new Map();

  for (const entry of har.log.entries) {
    // Parse each body once, then dispatch the pre-parsed result to every
    // format parser (avoids re-running JSON.parse / the SSE split per parser).
    const responseBody = getResponseBody(entry);
    if (responseBody) {
      const parsed = parseBody(responseBody);
      extractToolCallsFromBody(parsed, entry.startedDateTime, toolCalls);
      extractAnthropicToolCallsFromBody(parsed, entry.startedDateTime, toolCalls);
      extractResponsesApiToolCallsFromBody(parsed, entry.startedDateTime, toolCalls);
    }

    // Process request bodies for tool results (and, for the Responses API,
    // the accumulated tool-call transcript in `input[]`). Request bodies are
    // never SSE, so a single JSON parse suffices.
    const requestBody = getRequestBody(entry);
    if (requestBody) {
      const requestJson = tryParseJson(requestBody);
      extractToolResponsesFromBody(requestJson, toolResponses);
      extractResponsesApiFromRequestBody(requestJson, entry.startedDateTime, toolCalls, toolResponses);
    }

    // WebSocket transport: when the Responses API is carried over a WebSocket
    // (gateway-captured), the tool-call payloads live in `_webSocketMessages`
    // frames rather than HTTP bodies. No-op for HTTP-only HARs (DevProxy),
    // which have no `_webSocketMessages`.
    extractResponsesApiFromWebSocketMessages(
      entry._webSocketMessages,
      entry.startedDateTime,
      toolCalls,
      toolResponses,
    );
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
 * Extract tool_calls from a parsed response body.
 *
 * Handles both streaming (SSE) and non-streaming responses:
 * - Non-streaming: choices[].message.tool_calls (from `parsed.json`)
 * - Streaming: choices[].delta.tool_calls accumulated across `parsed.sseEvents`
 */
function extractToolCallsFromBody(
  parsed: ParsedBody,
  timestamp: string,
  toolCalls: Map<string, ToolCall>,
): void {
  // Non-streaming format: choices[].message.tool_calls
  if (parsed.json && typeof parsed.json === "object") {
    processChoices(parsed.json as Record<string, unknown>, timestamp, toolCalls);
  }

  // Streaming SSE format (empty for a single-JSON body). Accumulate partial
  // tool call data across chunks.
  const partialCalls: Map<string, { name: string; arguments: string }> = new Map();
  // Map SSE index → tool call id so continuation chunks (which only
  // carry `index`, not `id`) can find the right partial entry.
  const indexToId: Map<number, string> = new Map();
  // Auto-incrementing counter for initial chunks that lack an explicit index.
  let nextAutoIndex = 0;

  for (const event of parsed.sseEvents) {
    // Tolerate an unexpectedly-shaped event without aborting the whole HAR.
    try {
      if (!event || typeof event !== "object") continue;
      const json = event as Record<string, unknown>;
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
    if (!choice || typeof choice !== "object") continue;
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
  parsed: ParsedBody,
  timestamp: string,
  toolCalls: Map<string, ToolCall>,
): void {
  // Non-streaming format: content[].type === "tool_use"
  if (parsed.json && typeof parsed.json === "object") {
    try {
      const json = parsed.json as Record<string, unknown>;
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
      }
    } catch {
      // Tolerate malformed content blocks.
    }
  }

  // Anthropic SSE streaming format (empty for a single-JSON body).
  // Events: content_block_start (type: tool_use), content_block_delta (type: input_json_delta)
  const partialCalls: Map<number, { id: string; name: string; inputJson: string }> = new Map();

  for (const event of parsed.sseEvents) {
    // Tolerate an unexpectedly-shaped event without aborting the whole HAR.
    try {
      // Mirror the original JSON.parse typing (the nested Anthropic event shape
      // is dynamically checked below).
      const json = event as any;

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
 * Extract tool role messages from a parsed request body.
 * These contain the responses to tool calls, matched by tool_call_id.
 *
 * Handles both OpenAI format (role: "tool", tool_call_id) and
 * Anthropic format (content[].type === "tool_result", tool_use_id).
 *
 * Takes the request body already parsed by the caller; non-object values are
 * ignored. The body loop is wrapped so an unexpectedly-shaped message can't
 * throw and abort extraction for the whole HAR.
 */
function extractToolResponsesFromBody(
  json: unknown,
  toolResponses: Map<string, string>,
): void {
  if (!json || typeof json !== "object") return;
  try {
    // OpenAI format: messages[].role === "tool"
    const messages = (json as Record<string, unknown>).messages;
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
    // Tolerate malformed messages.
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
 *  Anthropic format: input_tokens, output_tokens, plus prompt-cache fields
 *  cache_creation_input_tokens / cache_read_input_tokens which are added to the
 *  prompt count since Anthropic's `input_tokens` excludes cached tokens).
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

  if (!found) {
    // Fallback: extract from telemetry POST request bodies (for WebSocket runs
    // where response bodies are empty). The Copilot CLI emits `assistant_usage`
    // events to the telemetry endpoint with metrics.{input_tokens, output_tokens}.
    const telemetryResult = extractTokenUsageFromTelemetry(har);
    if (telemetryResult) return telemetryResult;
    return undefined;
  }

  return { promptTokens, completionTokens, totalTokens };

  function accumulateUsage(json: Record<string, unknown>): boolean {
    // Check top-level usage first, then nested response.usage (Responses API)
    const usage = (json.usage as Record<string, unknown> | undefined)
      ?? ((json.response as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined);
    if (!usage || typeof usage !== "object") return false;

    // OpenAI / GitHub Models format
    if (typeof usage.prompt_tokens === "number") {
      promptTokens += usage.prompt_tokens;
      completionTokens += (usage.completion_tokens as number) ?? 0;
      totalTokens += (usage.total_tokens as number) ?? (usage.prompt_tokens + ((usage.completion_tokens as number) ?? 0));
      return true;
    }

    // OpenAI Responses API format (input_tokens + total_tokens present)
    if (typeof usage.input_tokens === "number" && typeof usage.total_tokens === "number") {
      promptTokens += usage.input_tokens;
      completionTokens += (usage.output_tokens as number) ?? 0;
      totalTokens += usage.total_tokens;
      return true;
    }

    // Anthropic format (input_tokens without total_tokens).
    // Anthropic reports prompt-cache tokens separately: `input_tokens` is only
    // the NON-cached remainder of the prompt. The bulk lives in
    // `cache_creation_input_tokens` (written to cache) and
    // `cache_read_input_tokens` (read back on later calls). The true prompt size
    // is the sum of all three — omitting the cache fields undercounts prompt
    // tokens by orders of magnitude when prompt caching is active (which it
    // always is for Claude via the Copilot CLI).
    if (typeof usage.input_tokens === "number") {
      const cacheCreation = (usage.cache_creation_input_tokens as number) ?? 0;
      const cacheRead = (usage.cache_read_input_tokens as number) ?? 0;
      const prompt = usage.input_tokens + cacheCreation + cacheRead;
      const completion = (usage.output_tokens as number) ?? 0;
      promptTokens += prompt;
      completionTokens += completion;
      totalTokens += prompt + completion;
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
 * - OpenAI Responses API: https://api.enterprise.githubcopilot.com/responses
 */
const AI_COMPLETION_URL_PATTERNS: ReadonlyArray<RegExp> = [
  /\/chat\/completions(\?|$)/,
  /\/v1\/messages(\?|$)/,
  /\/responses(\?|$)/,
];

/**
 * Count the number of AI completion calls captured in a HAR file.
 *
 * Counts entries matching AI completion URL patterns:
 * - POST with 2xx: standard REST completions (chat/completions, v1/messages,
 *   and HTTP-mode Responses API)
 * - GET with 101: WebSocket upgrade for the Responses API (Copilot CLI uses
 *   WebSocket transport when `copilot_cli_websocket_responses` flag is enabled)
 *
 * Excludes 429 retries and transient 5xx errors so the count reflects
 * successful agent interactions, not noise.
 */
export function extractAiCallCount(har: HarFile): number {
  const directCount = har.log.entries.filter((entry) => {
    if (!AI_COMPLETION_URL_PATTERNS.some((p) => p.test(entry.request.url))) return false;
    // POST 2xx: standard REST/SSE calls
    if (entry.request.method === "POST" && entry.response.status >= 200 && entry.response.status < 300) return true;
    // GET 101: WebSocket upgrade (Responses API)
    if (entry.request.method === "GET" && entry.response.status === 101) return true;
    return false;
  }).length;

  // If we found direct AI calls, use that count. Otherwise fall back to
  // counting assistant_usage telemetry events (for cases where DevProxy only
  // captures a single WebSocket upgrade but multiple LLM calls happened within).
  if (directCount > 0) return directCount;

  return countAiCallsFromTelemetry(har);
}

/** URL pattern for the Copilot telemetry endpoint. */
const TELEMETRY_URL_PATTERN = /\/telemetry(\?|$)/;

/**
 * Extract token usage from telemetry POST request bodies.
 *
 * When the Copilot CLI uses WebSocket transport for the Responses API, the HAR
 * captures only a 101 upgrade with no response body. However, the CLI posts
 * `assistant_usage` telemetry events that contain per-call token metrics.
 *
 * Each event has:
 * ```json
 * { "kind": "assistant_usage", "metrics": { "input_tokens": N, "output_tokens": N } }
 * ```
 *
 * This function sums those metrics as a fallback when response-body extraction
 * yields nothing.
 */
export function extractTokenUsageFromTelemetry(har: HarFile): TokenUsage | undefined {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let found = false;

  for (const entry of har.log.entries) {
    if (!TELEMETRY_URL_PATTERN.test(entry.request.url)) continue;
    if (entry.request.method !== "POST") continue;

    const body = entry.request?.postData?.text;
    if (!body) continue;

    // Telemetry bodies are NDJSON (newline-delimited JSON)
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        const props = event?.data?.baseData?.properties;
        if (!props?.payload) continue;
        const payload = JSON.parse(props.payload);
        if (payload?.kind !== "assistant_usage") continue;
        const metrics = payload.metrics;
        if (!metrics || typeof metrics.input_tokens !== "number") continue;

        promptTokens += metrics.input_tokens;
        completionTokens += (metrics.output_tokens as number) ?? 0;
        totalTokens += metrics.input_tokens + ((metrics.output_tokens as number) ?? 0);
        found = true;
      } catch {
        continue;
      }
    }
  }

  return found ? { promptTokens, completionTokens, totalTokens } : undefined;
}

/**
 * Count AI calls from telemetry `assistant_usage` events.
 * Used as a fallback when the HAR doesn't contain direct AI completion entries
 * (e.g. WebSocket transport where a single 101 upgrade covers many LLM calls).
 */
export function countAiCallsFromTelemetry(har: HarFile): number {
  let count = 0;
  for (const entry of har.log.entries) {
    if (!TELEMETRY_URL_PATTERN.test(entry.request.url)) continue;
    if (entry.request.method !== "POST") continue;

    const body = entry.request?.postData?.text;
    if (!body) continue;

    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        const props = event?.data?.baseData?.properties;
        if (!props?.payload) continue;
        const payload = JSON.parse(props.payload);
        if (payload?.kind === "assistant_usage") count++;
      } catch {
        continue;
      }
    }
  }
  return count;
}
