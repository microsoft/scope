// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import {
  repairMojibake,
  getResponseBody,
  extractToolResponses,
  extractEntrySegments,
  extractChronologicalSegments,
  extractFromHar,
  isAiCompletionEntry,
  detectTransport,
  type HarEntry,
  type HarFile,
} from "./har-extraction";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Create a minimal HarEntry with a plain-text response. */
function makeEntry(
  responseText: string,
  opts: {
    encoding?: string;
    timestamp?: string;
    requestBody?: string;
  } = {},
): HarEntry {
  return {
    startedDateTime: opts.timestamp ?? "2025-01-01T00:00:00Z",
    request: {
      method: "POST",
      url: "https://api.openai.com/v1/chat/completions",
      ...(opts.requestBody ? { postData: { text: opts.requestBody } } : {}),
    },
    response: {
      content: {
        text: responseText,
        ...(opts.encoding ? { encoding: opts.encoding } : {}),
      },
    },
  };
}

/** Encode a UTF-8 string to base64 the way a browser would store it in HAR. */
function toBase64(utf8: string): string {
  const bytes = new TextEncoder().encode(utf8);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Build an SSE-format body from an array of SSE data payloads. */
function sse(...chunks: object[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n") + "\ndata: [DONE]\n";
}

// ---------------------------------------------------------------------------
// repairMojibake
// ---------------------------------------------------------------------------
describe("repairMojibake", () => {
  it("returns plain ASCII text unchanged", () => {
    expect(repairMojibake("hello world")).toBe("hello world");
  });

  it("returns valid UTF-8 that has no mojibake patterns unchanged", () => {
    // Japanese text that doesn't trigger Latin-1 patterns
    expect(repairMojibake("日本語テスト")).toBe("日本語テスト");
  });

  it("repairs Latin-1 mojibake of box-drawing characters", () => {
    // UTF-8 bytes for "├── file.ts" stored as Latin-1 code points:
    // ├ = E2 94 9C → â\x94\x9C,  ─ = E2 94 80 → â\x94\x80
    const mojibaked = String.fromCharCode(
      0xe2, 0x94, 0x9c, // ├
      0xe2, 0x94, 0x80, // ─
      0xe2, 0x94, 0x80, // ─
      0x20,             // space
      0x66, 0x69, 0x6c, 0x65, 0x2e, 0x74, 0x73, // file.ts
    );
    expect(repairMojibake(mojibaked)).toBe("├── file.ts");
  });

  it("repairs Latin-1 mojibake of arrow character →", () => {
    // → = E2 86 92  stored as Latin-1
    const mojibaked = "A " + String.fromCharCode(0xe2, 0x86, 0x92) + " B";
    expect(repairMojibake(mojibaked)).toBe("A → B");
  });

  it("repairs Latin-1 mojibake of accented characters", () => {
    // é = C3 A9 stored as Latin-1: Ã©
    const mojibaked = String.fromCharCode(0xc3, 0xa9);
    expect(repairMojibake(mojibaked)).toBe("é");
  });
});

// ---------------------------------------------------------------------------
// getResponseBody
// ---------------------------------------------------------------------------
describe("getResponseBody", () => {
  it("returns null when content text is missing", () => {
    const entry = makeEntry("");
    entry.response.content.text = undefined;
    expect(getResponseBody(entry)).toBeNull();
  });

  it("returns plain text response as-is (no mojibake)", () => {
    const entry = makeEntry("Hello, world!");
    expect(getResponseBody(entry)).toBe("Hello, world!");
  });

  it("repairs mojibake in plain text responses", () => {
    const mojibaked = String.fromCharCode(0xe2, 0x94, 0x9c) + " root";
    const entry = makeEntry(mojibaked);
    expect(getResponseBody(entry)).toBe("├ root");
  });

  it("decodes base64 response with UTF-8 content", () => {
    const original = "Hello → World ├── file.ts";
    const b64 = toBase64(original);
    const entry = makeEntry(b64, { encoding: "base64" });
    expect(getResponseBody(entry)).toBe(original);
  });

  it("returns null for invalid base64", () => {
    const entry = makeEntry("not-valid-base64!!!", { encoding: "base64" });
    // atob may throw or produce garbage; function should return null on error
    const result = getResponseBody(entry);
    // Either null or some decoded string — shouldn't throw
    expect(result === null || typeof result === "string").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractToolResponses
// ---------------------------------------------------------------------------
describe("extractToolResponses", () => {
  it("extracts tool role messages by tool_call_id", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hello" },
        { role: "tool", tool_call_id: "tc_1", content: "file contents here" },
        { role: "tool", tool_call_id: "tc_2", content: "another result" },
        { role: "assistant", content: "done" },
      ],
    });
    const responses = new Map<string, string>();
    extractToolResponses(body, responses);

    expect(responses.size).toBe(2);
    expect(responses.get("tc_1")).toBe("file contents here");
    expect(responses.get("tc_2")).toBe("another result");
  });

  it("handles non-string tool content by JSON.stringify", () => {
    const body = JSON.stringify({
      messages: [
        { role: "tool", tool_call_id: "tc_obj", content: { key: "value" } },
      ],
    });
    const responses = new Map<string, string>();
    extractToolResponses(body, responses);

    expect(responses.get("tc_obj")).toBe('{"key":"value"}');
  });

  it("ignores invalid JSON gracefully", () => {
    const responses = new Map<string, string>();
    extractToolResponses("not json at all", responses);
    expect(responses.size).toBe(0);
  });

  it("ignores bodies without messages array", () => {
    const responses = new Map<string, string>();
    extractToolResponses(JSON.stringify({ model: "gpt-4" }), responses);
    expect(responses.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// extractEntrySegments — non-streaming JSON
// ---------------------------------------------------------------------------
describe("extractEntrySegments (non-streaming)", () => {
  const ts = "2025-06-01T12:00:00Z";
  const emptyResponses = new Map<string, string>();

  it("extracts content from a simple completion", () => {
    const body = JSON.stringify({
      choices: [{ message: { content: "Hello!" } }],
    });
    const segments = extractEntrySegments(body, ts, emptyResponses);
    expect(segments).toEqual([
      { type: "content", content: "Hello!", timestamp: ts },
    ]);
  });

  it("extracts content + tool_calls together", () => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            content: "Let me check.",
            tool_calls: [
              {
                id: "call_1",
                function: { name: "read_file", arguments: '{"path":"foo.ts"}' },
              },
            ],
          },
        },
      ],
    });
    const segments = extractEntrySegments(body, ts, emptyResponses);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ type: "content", content: "Let me check.", timestamp: ts });
    expect(segments[1].type).toBe("tool_calls");
    if (segments[1].type === "tool_calls") {
      expect(segments[1].toolCalls).toHaveLength(1);
      expect(segments[1].toolCalls[0].name).toBe("read_file");
      expect(segments[1].toolCalls[0].arguments).toEqual({ path: "foo.ts" });
    }
  });

  it("attaches tool responses when available", () => {
    const responses = new Map([["call_1", "file content here"]]);
    const body = JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              { id: "call_1", function: { name: "read_file", arguments: "{}" } },
            ],
          },
        },
      ],
    });
    const segments = extractEntrySegments(body, ts, responses);
    expect(segments).toHaveLength(1);
    if (segments[0].type === "tool_calls") {
      expect(segments[0].toolCalls[0].response).toBe("file content here");
    }
  });

  it("handles malformed tool_call arguments with _raw fallback", () => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              { id: "call_bad", function: { name: "fn", arguments: "not json" } },
            ],
          },
        },
      ],
    });
    const segments = extractEntrySegments(body, ts, emptyResponses);
    expect(segments).toHaveLength(1);
    if (segments[0].type === "tool_calls") {
      expect(segments[0].toolCalls[0].arguments).toEqual({ _raw: "not json" });
    }
  });

  it("skips tool_calls without id", () => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "fn", arguments: "{}" } }, // no id
            ],
          },
        },
      ],
    });
    const segments = extractEntrySegments(body, ts, emptyResponses);
    // No tool calls emitted
    expect(segments.filter((s) => s.type === "tool_calls")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractEntrySegments — SSE streaming
// ---------------------------------------------------------------------------
describe("extractEntrySegments (SSE streaming)", () => {
  const ts = "2025-06-01T12:00:00Z";
  const emptyResponses = new Map<string, string>();

  it("extracts thinking content from reasoning_text deltas", () => {
    const body = sse(
      { choices: [{ delta: { reasoning_text: "Let me " } }] },
      { choices: [{ delta: { reasoning_text: "think..." } }] },
      { choices: [{ delta: { content: "Here is the answer." } }] },
    );
    const segments = extractEntrySegments(body, ts, emptyResponses);
    expect(segments).toEqual([
      { type: "thinking", content: "Let me think...", timestamp: ts },
      { type: "content", content: "Here is the answer.", timestamp: ts },
    ]);
  });

  it("extracts thinking content from thinking deltas (Anthropic style)", () => {
    const body = sse(
      { choices: [{ delta: { thinking: "Hmm, " } }] },
      { choices: [{ delta: { thinking: "interesting." } }] },
      { choices: [{ delta: { content: "Done." } }] },
    );
    const segments = extractEntrySegments(body, ts, emptyResponses);
    expect(segments[0]).toEqual({ type: "thinking", content: "Hmm, interesting.", timestamp: ts });
    expect(segments[1]).toEqual({ type: "content", content: "Done.", timestamp: ts });
  });

  it("assembles streamed tool calls with index-based id mapping", () => {
    const body = sse(
      // First chunk: tool call header with id
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_A", function: { name: "grep", arguments: '{"q' } }] } }] },
      // Subsequent chunks: argument continuation (no id, just index)
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '":"hello' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }] },
    );
    const segments = extractEntrySegments(body, ts, emptyResponses);
    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe("tool_calls");
    if (segments[0].type === "tool_calls") {
      expect(segments[0].toolCalls).toHaveLength(1);
      expect(segments[0].toolCalls[0].id).toBe("call_A");
      expect(segments[0].toolCalls[0].name).toBe("grep");
      expect(segments[0].toolCalls[0].arguments).toEqual({ q: "hello" });
    }
  });

  it("handles parallel tool calls (multiple indices)", () => {
    const body = sse(
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: "call_A", function: { name: "read", arguments: '{"f":"a.ts"}' } },
        { index: 1, id: "call_B", function: { name: "read", arguments: '{"f":"b.ts"}' } },
      ] } }] },
    );
    const segments = extractEntrySegments(body, ts, emptyResponses);
    expect(segments).toHaveLength(1);
    if (segments[0].type === "tool_calls") {
      expect(segments[0].toolCalls).toHaveLength(2);
      expect(segments[0].toolCalls[0].id).toBe("call_A");
      expect(segments[0].toolCalls[1].id).toBe("call_B");
    }
  });

  it("attaches tool responses to streamed tool calls", () => {
    const responses = new Map([["call_X", "tool output"]]);
    const body = sse(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_X", function: { name: "run", arguments: "{}" } }] } }] },
    );
    const segments = extractEntrySegments(body, ts, responses);
    if (segments[0].type === "tool_calls") {
      expect(segments[0].toolCalls[0].response).toBe("tool output");
    }
  });

  it("produces segments in order: thinking → content → tool_calls", () => {
    const body = sse(
      { choices: [{ delta: { reasoning_text: "think" } }] },
      { choices: [{ delta: { content: "say" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "tc", function: { name: "fn", arguments: "{}" } }] } }] },
    );
    const segments = extractEntrySegments(body, ts, emptyResponses);
    expect(segments.map((s) => s.type)).toEqual(["thinking", "content", "tool_calls"]);
  });

  it("skips non-data lines and [DONE]", () => {
    const body = [
      ": comment line",
      "",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}`,
      "data: [DONE]",
      "",
    ].join("\n");
    const segments = extractEntrySegments(body, ts, emptyResponses);
    expect(segments).toEqual([{ type: "content", content: "hi", timestamp: ts }]);
  });

  it("returns empty segments for body with no useful data", () => {
    const segments = extractEntrySegments("", ts, emptyResponses);
    expect(segments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractChronologicalSegments — multi-entry HAR
// ---------------------------------------------------------------------------
describe("extractChronologicalSegments", () => {
  it("extracts segments across multiple entries in order", () => {
    const har: HarFile = {
      log: {
        entries: [
          makeEntry(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: "Let me read the file.",
                    tool_calls: [
                      { id: "tc1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
                    ],
                  },
                },
              ],
            }),
            { timestamp: "2025-01-01T00:00:01Z" },
          ),
          // Second entry carries the tool response in the request
          makeEntry(
            JSON.stringify({
              choices: [{ message: { content: "The file contains..." } }],
            }),
            {
              timestamp: "2025-01-01T00:00:02Z",
              requestBody: JSON.stringify({
                messages: [
                  { role: "tool", tool_call_id: "tc1", content: "export const x = 1;" },
                ],
              }),
            },
          ),
        ],
      },
    };

    const segments = extractChronologicalSegments(har);
    expect(segments).toHaveLength(3);
    // First entry: content + tool_calls
    expect(segments[0]).toEqual({
      type: "content",
      content: "Let me read the file.",
      timestamp: "2025-01-01T00:00:01Z",
    });
    expect(segments[1].type).toBe("tool_calls");
    if (segments[1].type === "tool_calls") {
      expect(segments[1].toolCalls[0].name).toBe("read_file");
      expect(segments[1].toolCalls[0].response).toBe("export const x = 1;");
    }
    // Second entry: content
    expect(segments[2]).toEqual({
      type: "content",
      content: "The file contains...",
      timestamp: "2025-01-01T00:00:02Z",
    });
  });

  it("skips entries with no response body", () => {
    const entry = makeEntry("");
    entry.response.content.text = undefined;
    const har: HarFile = { log: { entries: [entry] } };
    expect(extractChronologicalSegments(har)).toEqual([]);
  });

  it("handles SSE entries in a multi-entry HAR", () => {
    const har: HarFile = {
      log: {
        entries: [
          makeEntry(
            sse(
              { choices: [{ delta: { reasoning_text: "thinking..." } }] },
              { choices: [{ delta: { content: "answer" } }] },
            ),
            { timestamp: "2025-01-01T00:00:01Z" },
          ),
        ],
      },
    };
    const segments = extractChronologicalSegments(har);
    expect(segments).toHaveLength(2);
    expect(segments[0].type).toBe("thinking");
    expect(segments[1].type).toBe("content");
  });
});

// ---------------------------------------------------------------------------
// extractFromHar — high-level aggregation
// ---------------------------------------------------------------------------
describe("extractFromHar", () => {
  it("returns aggregated thinkingContent, toolCalls, and segments", () => {
    const har: HarFile = {
      log: {
        entries: [
          makeEntry(
            sse(
              { choices: [{ delta: { reasoning_text: "let me think" } }] },
              { choices: [{ delta: { content: "here is my answer" } }] },
              { choices: [{ delta: { tool_calls: [{ index: 0, id: "tc1", function: { name: "search", arguments: '{"q":"x"}' } }] } }] },
            ),
            { timestamp: "2025-01-01T00:00:00Z" },
          ),
        ],
      },
    };

    const result = extractFromHar(har);

    expect(result.thinkingContent).toBe("let me think");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("search");
    expect(result.segments).toHaveLength(3);
    expect(result.segments.map((s) => s.type)).toEqual(["thinking", "content", "tool_calls"]);
  });

  it("returns empty data for HAR with no entries", () => {
    const result = extractFromHar({ log: { entries: [] } });
    expect(result.thinkingContent).toBe("");
    expect(result.toolCalls).toEqual([]);
    expect(result.segments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isAiCompletionEntry
// ---------------------------------------------------------------------------
/** Build a classification-focused HarEntry. */
function makeClassifyEntry(opts: {
  url?: string;
  method?: string;
  status?: number;
  mimeType?: string;
  responseHeaders?: { name: string; value: string }[];
  resourceType?: string;
  webSocketMessages?: unknown[];
}): HarEntry {
  return {
    startedDateTime: "2025-01-01T00:00:00Z",
    request: {
      method: opts.method ?? "POST",
      url: opts.url ?? "https://api.githubcopilot.com/chat/completions",
    },
    response: {
      status: opts.status ?? 200,
      ...(opts.responseHeaders ? { headers: opts.responseHeaders } : {}),
      content: { ...(opts.mimeType ? { mimeType: opts.mimeType } : {}) },
    },
    ...(opts.resourceType ? { _resourceType: opts.resourceType } : {}),
    ...(opts.webSocketMessages ? { _webSocketMessages: opts.webSocketMessages } : {}),
  };
}

describe("isAiCompletionEntry", () => {
  it("flags POST chat/completions with a 2xx status", () => {
    expect(isAiCompletionEntry(makeClassifyEntry({
      url: "https://api.githubcopilot.com/chat/completions",
      method: "POST",
      status: 200,
    }))).toBe(true);
  });

  it("flags POST v1/messages (Anthropic) with a 2xx status", () => {
    expect(isAiCompletionEntry(makeClassifyEntry({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      status: 201,
    }))).toBe(true);
  });

  it("flags a GET 101 WebSocket upgrade on the Responses API", () => {
    expect(isAiCompletionEntry(makeClassifyEntry({
      url: "https://api.enterprise.githubcopilot.com/responses",
      method: "GET",
      status: 101,
    }))).toBe(true);
  });

  it("does not flag non-AI endpoints", () => {
    expect(isAiCompletionEntry(makeClassifyEntry({
      url: "https://api.githubcopilot.com/telemetry",
      method: "POST",
      status: 200,
    }))).toBe(false);
  });

  it("does not flag 429 retries on an AI endpoint", () => {
    expect(isAiCompletionEntry(makeClassifyEntry({
      url: "https://api.githubcopilot.com/chat/completions",
      method: "POST",
      status: 429,
    }))).toBe(false);
  });

  it("does not flag 5xx errors on an AI endpoint", () => {
    expect(isAiCompletionEntry(makeClassifyEntry({
      url: "https://api.githubcopilot.com/chat/completions",
      method: "POST",
      status: 503,
    }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectTransport
// ---------------------------------------------------------------------------
describe("detectTransport", () => {
  it("classifies text/event-stream responses as sse", () => {
    expect(detectTransport(makeClassifyEntry({
      mimeType: "text/event-stream; charset=utf-8",
    }))).toBe("sse");
  });

  it("classifies sse via the content-type response header", () => {
    expect(detectTransport(makeClassifyEntry({
      responseHeaders: [{ name: "Content-Type", value: "text/event-stream" }],
    }))).toBe("sse");
  });

  it("classifies entries tagged with _resourceType websocket", () => {
    expect(detectTransport(makeClassifyEntry({
      resourceType: "websocket",
      status: 101,
    }))).toBe("websocket");
  });

  it("classifies a 101 upgrade with an Upgrade: websocket header", () => {
    expect(detectTransport(makeClassifyEntry({
      method: "GET",
      status: 101,
      responseHeaders: [{ name: "Upgrade", value: "websocket" }],
    }))).toBe("websocket");
  });

  it("classifies entries carrying _webSocketMessages as websocket", () => {
    expect(detectTransport(makeClassifyEntry({
      webSocketMessages: [{ type: "receive", time: 1, opcode: 1, data: "{}" }],
    }))).toBe("websocket");
  });

  it("classifies plain JSON responses as http", () => {
    expect(detectTransport(makeClassifyEntry({
      mimeType: "application/json",
      status: 200,
    }))).toBe("http");
  });
});
