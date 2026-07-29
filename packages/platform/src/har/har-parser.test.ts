// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseHarFile, extractToolCalls, sanitizeHar, extractThinkingContent, extractTokenUsage, extractAiCallCount } from "./har-parser.js";
import type { HarFile, ToolCall } from "./types.js";

// Mock fs/promises for parseHarFile tests
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

import { readFile } from "node:fs/promises";
const mockReadFile = vi.mocked(readFile);

/**
 * Helper to build a minimal HAR file structure.
 */
function makeHar(entries: HarFile["log"]["entries"]): HarFile {
  return {
    log: {
      version: "1.2",
      creator: { name: "DevProxy", version: "0.26.0" },
      entries,
    },
  };
}

/**
 * Helper to build a HAR entry with a JSON request/response body.
 */
function makeEntry(opts: {
  url?: string;
  requestBody?: unknown;
  responseBody?: unknown;
  responseEncoding?: string;
  timestamp?: string;
}): HarFile["log"]["entries"][0] {
  const responseText = opts.responseBody
    ? typeof opts.responseBody === "string"
      ? opts.responseBody
      : JSON.stringify(opts.responseBody)
    : undefined;

  return {
    startedDateTime: opts.timestamp || "2025-01-15T10:00:00.000Z",
    time: 100,
    request: {
      method: "POST",
      url: opts.url || "https://api.githubcopilot.com/chat/completions",
      httpVersion: "HTTP/1.1",
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: -1,
      ...(opts.requestBody
        ? {
            postData: {
              mimeType: "application/json",
              text: JSON.stringify(opts.requestBody),
            },
          }
        : {}),
    },
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      headers: [],
      content: {
        size: responseText?.length || 0,
        mimeType: "application/json",
        text: responseText,
        encoding: opts.responseEncoding,
      },
      headersSize: -1,
      bodySize: -1,
      redirectURL: "",
    },
  };
}

describe("parseHarFile", () => {
  it("reads and parses a HAR file from disk", async () => {
    const har = makeHar([]);
    mockReadFile.mockResolvedValueOnce(JSON.stringify(har));

    const result = await parseHarFile("/tmp/test.har");

    expect(mockReadFile).toHaveBeenCalledWith("/tmp/test.har", "utf-8");
    expect(result).toEqual(har);
  });

  it("throws on invalid JSON", async () => {
    mockReadFile.mockResolvedValueOnce("not-json");

    await expect(parseHarFile("/tmp/bad.har")).rejects.toThrow();
  });
});

describe("extractToolCalls", () => {
  describe("non-streaming responses", () => {
    it("extracts tool calls from a standard chat completion response", () => {
      const har = makeHar([
        makeEntry({
          responseBody: {
            choices: [
              {
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      id: "call_001",
                      function: {
                        name: "read_file",
                        arguments: '{"path":"src/index.ts"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      ]);

      const calls = extractToolCalls(har);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        id: "call_001",
        name: "read_file",
        arguments: { path: "src/index.ts" },
        timestamp: "2025-01-15T10:00:00.000Z",
      });
    });

    it("extracts multiple tool calls from a single response", () => {
      const har = makeHar([
        makeEntry({
          responseBody: {
            choices: [
              {
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      id: "call_a",
                      function: { name: "read_file", arguments: '{"path":"a.ts"}' },
                    },
                    {
                      id: "call_b",
                      function: { name: "write_file", arguments: '{"path":"b.ts","content":"hello"}' },
                    },
                  ],
                },
              },
            ],
          },
        }),
      ]);

      const calls = extractToolCalls(har);

      expect(calls).toHaveLength(2);
      expect(calls[0].name).toBe("read_file");
      expect(calls[1].name).toBe("write_file");
    });

    it("deduplicates tool calls by id", () => {
      const responseBody = {
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                { id: "call_dup", function: { name: "read_file", arguments: '{}' } },
              ],
            },
          },
        ],
      };

      const har = makeHar([
        makeEntry({ responseBody }),
        makeEntry({ responseBody }),
      ]);

      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(1);
    });

    it("handles unparseable arguments as _raw", () => {
      const har = makeHar([
        makeEntry({
          responseBody: {
            choices: [
              {
                message: {
                  tool_calls: [
                    { id: "call_x", function: { name: "broken", arguments: "not-json{" } },
                  ],
                },
              },
            ],
          },
        }),
      ]);

      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments).toEqual({ _raw: "not-json{" });
    });
  });

  describe("streaming responses (SSE)", () => {
    it("accumulates tool calls from SSE data chunks", () => {
      const sseBody = [
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_sse","function":{"name":"list_files","arguments":"{\\"dir\\""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"src\\"}"}}]}}]}',
        "data: [DONE]",
      ].join("\n");

      const har = makeHar([
        makeEntry({ responseBody: sseBody }),
      ]);

      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("list_files");
      expect(calls[0].arguments).toEqual({ dir: "src" });
    });

    it("skips malformed SSE lines", () => {
      const sseBody = [
        "data: not-json",
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_ok","function":{"name":"foo","arguments":"{}"}}]}}]}',
        "data: [DONE]",
      ].join("\n");

      const har = makeHar([makeEntry({ responseBody: sseBody })]);
      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("foo");
    });

    it("accumulates arguments for tool calls with non-zero SSE index", () => {
      // Reproduces the bug where a tool call arrives at SSE index=1
      // (e.g. the second parallel tool call in the batch) and the
      // first SSE chunk has no arguments field.
      const sseBody = [
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_skill","index":1,"function":{"name":"skill"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"skill\\""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":": \\"flask-python\\"}"}}]}}]}',
        "data: [DONE]",
      ].join("\n");

      const har = makeHar([makeEntry({ responseBody: sseBody })]);
      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("skill");
      expect(calls[0].arguments).toEqual({ skill: "flask-python" });
    });

    it("accumulates multiple parallel streaming tool calls with different indices", () => {
      // Two tool calls streamed in parallel: report_intent at index 1, update_todo at index 2
      const sseBody = [
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_report","index":1,"function":{"name":"report_intent"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_todo","index":2,"function":{"name":"update_todo"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"intent\\": \\"Creating Flask REST API\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":2,"function":{"arguments":"{\\"todos\\": \\"- [ ] Setup\\"}"}}]}}]}',
        "data: [DONE]",
      ].join("\n");

      const har = makeHar([makeEntry({ responseBody: sseBody })]);
      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(2);
      expect(calls[0].name).toBe("report_intent");
      expect(calls[0].arguments).toEqual({ intent: "Creating Flask REST API" });
      expect(calls[1].name).toBe("update_todo");
      expect(calls[1].arguments).toEqual({ todos: "- [ ] Setup" });
    });
  });

  describe("tool responses", () => {
    it("matches tool role messages to tool calls by tool_call_id", () => {
      const har = makeHar([
        // First entry: response with tool_calls
        makeEntry({
          responseBody: {
            choices: [
              {
                message: {
                  tool_calls: [
                    { id: "call_123", function: { name: "read_file", arguments: '{"path":"x.ts"}' } },
                  ],
                },
              },
            ],
          },
        }),
        // Second entry: request with tool role message
        makeEntry({
          requestBody: {
            messages: [
              { role: "tool", tool_call_id: "call_123", content: "file contents here" },
            ],
          },
          responseBody: { choices: [] },
        }),
      ]);

      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(1);
      expect(calls[0].response).toBe("file contents here");
    });

    it("handles tool responses with object content", () => {
      const har = makeHar([
        makeEntry({
          responseBody: {
            choices: [
              {
                message: {
                  tool_calls: [
                    { id: "call_obj", function: { name: "api_call", arguments: '{}' } },
                  ],
                },
              },
            ],
          },
        }),
        makeEntry({
          requestBody: {
            messages: [
              { role: "tool", tool_call_id: "call_obj", content: { result: "ok" } },
            ],
          },
          responseBody: { choices: [] },
        }),
      ]);

      const calls = extractToolCalls(har);
      expect(calls[0].response).toBe('{"result":"ok"}');
    });

    it("leaves response undefined when no matching tool message exists", () => {
      const har = makeHar([
        makeEntry({
          responseBody: {
            choices: [
              {
                message: {
                  tool_calls: [
                    { id: "call_orphan", function: { name: "orphan", arguments: '{}' } },
                  ],
                },
              },
            ],
          },
        }),
      ]);

      const calls = extractToolCalls(har);
      expect(calls[0].response).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("returns empty array for HAR with no entries", () => {
      const har = makeHar([]);
      expect(extractToolCalls(har)).toEqual([]);
    });

    it("returns empty array for entries with no tool calls", () => {
      const har = makeHar([
        makeEntry({
          responseBody: {
            choices: [
              { message: { role: "assistant", content: "Hello!" } },
            ],
          },
        }),
      ]);
      expect(extractToolCalls(har)).toEqual([]);
    });

    it("handles base64-encoded response content", () => {
      const responseJson = JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                { id: "call_b64", function: { name: "b64_tool", arguments: '{}' } },
              ],
            },
          },
        ],
      });
      const b64 = Buffer.from(responseJson).toString("base64");

      const har = makeHar([
        makeEntry({
          responseBody: b64,
          responseEncoding: "base64",
        }),
      ]);

      // The entry needs the raw base64 text with encoding set
      // Override the entry to set encoding properly
      har.log.entries[0].response.content.text = b64;
      har.log.entries[0].response.content.encoding = "base64";

      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("b64_tool");
    });

    it("handles entries with no response body", () => {
      const har = makeHar([
        makeEntry({}),
      ]);
      har.log.entries[0].response.content.text = undefined;

      expect(extractToolCalls(har)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// extractToolCalls — Anthropic Messages API
// ---------------------------------------------------------------------------

describe("extractToolCalls (Anthropic)", () => {
  describe("non-streaming responses", () => {
    it("extracts tool_use blocks from Anthropic response", () => {
      const har = makeHar([
        makeEntry({
          url: "https://api.anthropic.com/v1/messages",
          responseBody: {
            id: "msg_123",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_01A",
                name: "read_file",
                input: { path: "/src/index.ts" },
              },
            ],
            stop_reason: "tool_use",
          },
        }),
      ]);

      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        id: "toolu_01A",
        name: "read_file",
        arguments: { path: "/src/index.ts" },
      });
    });

    it("extracts multiple tool_use blocks from a single response", () => {
      const har = makeHar([
        makeEntry({
          url: "https://api.anthropic.com/v1/messages",
          responseBody: {
            type: "message",
            content: [
              { type: "text", text: "I'll read and write files." },
              { type: "tool_use", id: "toolu_01", name: "read_file", input: { path: "a.ts" } },
              { type: "tool_use", id: "toolu_02", name: "write_file", input: { path: "b.ts", content: "x" } },
            ],
          },
        }),
      ]);

      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(2);
      expect(calls.map((c) => c.name)).toEqual(["read_file", "write_file"]);
    });

    it("ignores non-tool_use content blocks", () => {
      const har = makeHar([
        makeEntry({
          url: "https://api.anthropic.com/v1/messages",
          responseBody: {
            type: "message",
            content: [
              { type: "text", text: "Hello!" },
              { type: "thinking", thinking: "Let me think..." },
            ],
          },
        }),
      ]);

      expect(extractToolCalls(har)).toHaveLength(0);
    });
  });

  describe("streaming responses (SSE)", () => {
    it("accumulates tool calls from content_block_start and input_json_delta", () => {
      const sseBody = [
        'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[]}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_stream_01","name":"bash"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":": \\"ls -la\\"}"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"message_stop"}',
      ].join("\n");

      const har = makeHar([
        makeEntry({
          url: "https://api.anthropic.com/v1/messages",
          responseBody: sseBody,
        }),
      ]);

      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        id: "toolu_stream_01",
        name: "bash",
        arguments: { command: "ls -la" },
      });
    });

    it("handles multiple parallel streaming tool calls", () => {
      const sseBody = [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_a","name":"read"}}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_b","name":"write"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\": \\"x.ts\\"}"}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\": \\"y.ts\\"}"}}',
      ].join("\n");

      const har = makeHar([
        makeEntry({
          url: "https://api.anthropic.com/v1/messages",
          responseBody: sseBody,
        }),
      ]);

      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(2);
      expect(calls.map((c) => c.id)).toContain("toolu_a");
      expect(calls.map((c) => c.id)).toContain("toolu_b");
    });
  });

  describe("tool responses (tool_result)", () => {
    it("matches tool_result blocks to tool_use calls by tool_use_id", () => {
      const har = makeHar([
        // Response with tool_use
        makeEntry({
          url: "https://api.anthropic.com/v1/messages",
          responseBody: {
            type: "message",
            content: [
              { type: "tool_use", id: "toolu_match", name: "bash", input: { command: "pwd" } },
            ],
          },
        }),
        // Follow-up request with tool_result
        makeEntry({
          url: "https://api.anthropic.com/v1/messages",
          requestBody: {
            messages: [
              {
                role: "user",
                content: [
                  { type: "tool_result", tool_use_id: "toolu_match", content: "/workspace" },
                ],
              },
            ],
          },
          responseBody: { type: "message", content: [{ type: "text", text: "Got it." }] },
        }),
      ]);

      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(1);
      expect(calls[0].response).toBe("/workspace");
    });

    it("handles tool_result with object content", () => {
      const har = makeHar([
        makeEntry({
          url: "https://api.anthropic.com/v1/messages",
          responseBody: {
            type: "message",
            content: [
              { type: "tool_use", id: "toolu_obj", name: "search", input: { query: "test" } },
            ],
          },
        }),
        makeEntry({
          url: "https://api.anthropic.com/v1/messages",
          requestBody: {
            messages: [
              {
                role: "user",
                content: [
                  { type: "tool_result", tool_use_id: "toolu_obj", content: [{ type: "text", text: "found 3 results" }] },
                ],
              },
            ],
          },
          responseBody: { type: "message", content: [] },
        }),
      ]);

      const calls = extractToolCalls(har);
      expect(calls[0].response).toBe(JSON.stringify([{ type: "text", text: "found 3 results" }]));
    });
  });
});

/** Helper to build a HAR entry with explicit headers. */
function makeEntryWithHeaders(opts: {
  requestHeaders?: { name: string; value: string }[];
  responseHeaders?: { name: string; value: string }[];
}): HarFile["log"]["entries"][0] {
  const base = makeEntry({});
  return {
    ...base,
    request: {
      ...base.request,
      headers: opts.requestHeaders ?? [],
    },
    response: {
      ...base.response,
      headers: opts.responseHeaders ?? [],
    },
  };
}

describe("sanitizeHar", () => {
  it("redacts Authorization header", () => {
    const har = makeHar([
      makeEntryWithHeaders({
        requestHeaders: [
          { name: "Authorization", value: "Bearer ghp_secret123" },
          { name: "Content-Type", value: "application/json" },
        ],
      }),
    ]);

    const sanitized = sanitizeHar(har);

    expect(sanitized.log.entries[0].request.headers).toEqual([
      { name: "Authorization", value: "[REDACTED]" },
      { name: "Content-Type", value: "application/json" },
    ]);
  });

  it("redacts headers case-insensitively", () => {
    const har = makeHar([
      makeEntryWithHeaders({
        requestHeaders: [
          { name: "authorization", value: "Bearer token" },
          { name: "AUTHORIZATION", value: "Bearer TOKEN" },
        ],
      }),
    ]);

    const sanitized = sanitizeHar(har);

    for (const h of sanitized.log.entries[0].request.headers) {
      expect(h.value).toBe("[REDACTED]");
    }
  });

  it("redacts X-GitHub-Token header", () => {
    const har = makeHar([
      makeEntryWithHeaders({
        requestHeaders: [
          { name: "X-GitHub-Token", value: "ghu_token456" },
        ],
      }),
    ]);

    const sanitized = sanitizeHar(har);
    expect(sanitized.log.entries[0].request.headers[0].value).toBe("[REDACTED]");
  });

  it("redacts api-key and X-Api-Key headers", () => {
    const har = makeHar([
      makeEntryWithHeaders({
        requestHeaders: [
          { name: "api-key", value: "sk-12345" },
          { name: "X-Api-Key", value: "key-67890" },
        ],
      }),
    ]);

    const sanitized = sanitizeHar(har);
    expect(sanitized.log.entries[0].request.headers).toEqual([
      { name: "api-key", value: "[REDACTED]" },
      { name: "X-Api-Key", value: "[REDACTED]" },
    ]);
  });

  it("redacts response OAuth scope headers", () => {
    const har = makeHar([
      makeEntryWithHeaders({
        responseHeaders: [
          { name: "X-OAuth-Scopes", value: "repo, user" },
          { name: "X-Accepted-OAuth-Scopes", value: "repo" },
          { name: "X-RateLimit-Remaining", value: "42" },
        ],
      }),
    ]);

    const sanitized = sanitizeHar(har);
    expect(sanitized.log.entries[0].response.headers).toEqual([
      { name: "X-OAuth-Scopes", value: "[REDACTED]" },
      { name: "X-Accepted-OAuth-Scopes", value: "[REDACTED]" },
      { name: "X-RateLimit-Remaining", value: "42" },
    ]);
  });

  it("redacts Cookie and Set-Cookie headers", () => {
    const har = makeHar([
      makeEntryWithHeaders({
        requestHeaders: [{ name: "Cookie", value: "session=abc" }],
        responseHeaders: [{ name: "Set-Cookie", value: "session=xyz; path=/" }],
      }),
    ]);

    const sanitized = sanitizeHar(har);
    expect(sanitized.log.entries[0].request.headers[0].value).toBe("[REDACTED]");
    expect(sanitized.log.entries[0].response.headers[0].value).toBe("[REDACTED]");
  });

  it("does not mutate the original HAR object", () => {
    const har = makeHar([
      makeEntryWithHeaders({
        requestHeaders: [{ name: "Authorization", value: "Bearer secret" }],
      }),
    ]);

    const originalValue = har.log.entries[0].request.headers[0].value;
    sanitizeHar(har);
    expect(har.log.entries[0].request.headers[0].value).toBe(originalValue);
  });

  it("preserves non-sensitive headers", () => {
    const har = makeHar([
      makeEntryWithHeaders({
        requestHeaders: [
          { name: "Content-Type", value: "application/json" },
          { name: "Accept", value: "*/*" },
          { name: "User-Agent", value: "test/1.0" },
        ],
      }),
    ]);

    const sanitized = sanitizeHar(har);
    expect(sanitized.log.entries[0].request.headers).toEqual(
      har.log.entries[0].request.headers,
    );
  });

  it("handles HAR with no entries", () => {
    const har = makeHar([]);
    const sanitized = sanitizeHar(har);
    expect(sanitized.log.entries).toEqual([]);
  });

  it("sanitizes multiple entries independently", () => {
    const har = makeHar([
      makeEntryWithHeaders({
        requestHeaders: [{ name: "Authorization", value: "Bearer token1" }],
      }),
      makeEntryWithHeaders({
        requestHeaders: [{ name: "Authorization", value: "Bearer token2" }],
      }),
    ]);

    const sanitized = sanitizeHar(har);
    expect(sanitized.log.entries).toHaveLength(2);
    expect(sanitized.log.entries[0].request.headers[0].value).toBe("[REDACTED]");
    expect(sanitized.log.entries[1].request.headers[0].value).toBe("[REDACTED]");
  });
});

describe("extractThinkingContent", () => {
  it("extracts reasoning_text from SSE streaming responses", () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"delta":{"reasoning_text":"Let me think"}}]}',
      'data: {"choices":[{"delta":{"reasoning_text":" about this."}}]}',
      'data: {"choices":[{"delta":{"content":"Here is the answer."}}]}',
      "data: [DONE]",
    ].join("\n");

    const har = makeHar([makeEntry({ responseBody: sseBody })]);
    const thinking = extractThinkingContent(har);
    expect(thinking).toBe("Let me think about this.");
  });

  it("extracts thinking field from SSE streaming responses", () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"delta":{"thinking":"Analyzing the request"}}]}',
      'data: {"choices":[{"delta":{"thinking":" carefully."}}]}',
      "data: [DONE]",
    ].join("\n");

    const har = makeHar([makeEntry({ responseBody: sseBody })]);
    const thinking = extractThinkingContent(har);
    expect(thinking).toBe("Analyzing the request carefully.");
  });

  it("concatenates thinking from multiple entries", () => {
    const entry1Body = [
      'data: {"choices":[{"delta":{"reasoning_text":"First thought."}}]}',
      "data: [DONE]",
    ].join("\n");
    const entry2Body = [
      'data: {"choices":[{"delta":{"reasoning_text":"Second thought."}}]}',
      "data: [DONE]",
    ].join("\n");

    const har = makeHar([
      makeEntry({ responseBody: entry1Body }),
      makeEntry({ responseBody: entry2Body }),
    ]);
    const thinking = extractThinkingContent(har);
    expect(thinking).toBe("First thought.Second thought.");
  });

  it("returns empty string when no thinking content present", () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Just content."}}]}',
      "data: [DONE]",
    ].join("\n");

    const har = makeHar([makeEntry({ responseBody: sseBody })]);
    const thinking = extractThinkingContent(har);
    expect(thinking).toBe("");
  });

  it("skips empty reasoning_text values", () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"reasoning_text":""}}]}',
      'data: {"choices":[{"delta":{"reasoning_text":"Actual thought."}}]}',
      "data: [DONE]",
    ].join("\n");

    const har = makeHar([makeEntry({ responseBody: sseBody })]);
    const thinking = extractThinkingContent(har);
    expect(thinking).toBe("Actual thought.");
  });

  it("handles non-streaming JSON responses gracefully", () => {
    const har = makeHar([
      makeEntry({
        responseBody: {
          choices: [{ message: { role: "assistant", content: "No thinking here" } }],
        },
      }),
    ]);
    const thinking = extractThinkingContent(har);
    expect(thinking).toBe("");
  });

  it("extracts thinking from non-streaming Anthropic response", () => {
    const har = makeHar([
      makeEntry({
        url: "https://api.anthropic.com/v1/messages",
        responseBody: {
          type: "message",
          content: [
            { type: "thinking", thinking: "Let me analyze this step by step." },
            { type: "text", text: "Here's my answer." },
          ],
        },
      }),
    ]);
    const thinking = extractThinkingContent(har);
    expect(thinking).toBe("Let me analyze this step by step.");
  });

  it("extracts thinking from Anthropic streaming thinking_delta", () => {
    const sseBody = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Step 1: "}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"analyze input."}}',
      'data: {"type":"content_block_stop","index":0}',
    ].join("\n");

    const har = makeHar([
      makeEntry({
        url: "https://api.anthropic.com/v1/messages",
        responseBody: sseBody,
      }),
    ]);
    const thinking = extractThinkingContent(har);
    expect(thinking).toBe("Step 1: analyze input.");
  });
});

describe("extractTokenUsage", () => {
  it("returns undefined when no usage data is present", () => {
    const har = makeHar([
      makeEntry({
        responseBody: {
          choices: [{ message: { role: "assistant", content: "hello" } }],
        },
      }),
    ]);
    expect(extractTokenUsage(har)).toBeUndefined();
  });

  it("extracts OpenAI-format token usage from non-streaming response", () => {
    const har = makeHar([
      makeEntry({
        responseBody: {
          choices: [{ message: { role: "assistant", content: "done" } }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
          },
        },
      }),
    ]);
    const usage = extractTokenUsage(har);
    expect(usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
  });

  it("sums token usage across multiple HAR entries", () => {
    const har = makeHar([
      makeEntry({
        responseBody: {
          choices: [{ message: { role: "assistant", content: "first" } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        },
      }),
      makeEntry({
        responseBody: {
          choices: [{ message: { role: "assistant", content: "second" } }],
          usage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 },
        },
      }),
    ]);
    const usage = extractTokenUsage(har);
    expect(usage).toEqual({
      promptTokens: 300,
      completionTokens: 130,
      totalTokens: 430,
    });
  });

  it("extracts Anthropic-format token usage (input_tokens / output_tokens)", () => {
    const har = makeHar([
      makeEntry({
        responseBody: {
          content: [{ type: "text", text: "hello" }],
          usage: {
            input_tokens: 200,
            output_tokens: 75,
          },
        },
      }),
    ]);
    const usage = extractTokenUsage(har);
    expect(usage).toEqual({
      promptTokens: 200,
      completionTokens: 75,
      totalTokens: 275,
    });
  });

  it("extracts token usage from SSE streaming response (final chunk)", () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: {"choices":[{"delta":{"content":" there"}}],"usage":{"prompt_tokens":50,"completion_tokens":20,"total_tokens":70}}',
      "data: [DONE]",
    ].join("\n");

    const har = makeHar([
      makeEntry({ responseBody: sseBody }),
    ]);
    const usage = extractTokenUsage(har);
    expect(usage).toEqual({
      promptTokens: 50,
      completionTokens: 20,
      totalTokens: 70,
    });
  });

  it("returns undefined for empty HAR", () => {
    const har = makeHar([]);
    expect(extractTokenUsage(har)).toBeUndefined();
  });

  it("ignores entries without response bodies", () => {
    const har = makeHar([
      makeEntry({}),
    ]);
    expect(extractTokenUsage(har)).toBeUndefined();
  });
});

describe("extractAiCallCount", () => {
  it("counts GitHub Copilot completion entries", () => {
    const har = makeHar([
      makeEntry({ url: "https://api.githubcopilot.com/chat/completions" }),
      makeEntry({ url: "https://api.githubcopilot.com/chat/completions" }),
    ]);
    expect(extractAiCallCount(har)).toBe(2);
  });

  it("counts GitHub Models completion entries", () => {
    const har = makeHar([
      makeEntry({ url: "https://models.inference.ai.azure.com/chat/completions" }),
    ]);
    expect(extractAiCallCount(har)).toBe(1);
  });

  it("counts Anthropic messages entries", () => {
    const har = makeHar([
      makeEntry({ url: "https://api.anthropic.com/v1/messages" }),
      makeEntry({ url: "https://api.anthropic.com/v1/messages" }),
      makeEntry({ url: "https://api.anthropic.com/v1/messages" }),
    ]);
    expect(extractAiCallCount(har)).toBe(3);
  });

  it("counts mixed providers", () => {
    const har = makeHar([
      makeEntry({ url: "https://api.githubcopilot.com/chat/completions" }),
      makeEntry({ url: "https://api.anthropic.com/v1/messages" }),
    ]);
    expect(extractAiCallCount(har)).toBe(2);
  });

  it("ignores non-completion entries", () => {
    const har = makeHar([
      makeEntry({ url: "https://api.githubcopilot.com/chat/completions" }),
      makeEntry({ url: "https://api.githubcopilot.com/models" }),
      makeEntry({ url: "https://api.anthropic.com/v1/tokenize" }),
    ]);
    expect(extractAiCallCount(har)).toBe(1);
  });

  it("counts completion URLs with query parameters (e.g. Azure OpenAI api-version)", () => {
    const har = makeHar([
      makeEntry({ url: "https://my-resource.openai.azure.com/chat/completions?api-version=2024-02-01" }),
      makeEntry({ url: "https://api.anthropic.com/v1/messages?beta=true" }),
    ]);
    expect(extractAiCallCount(har)).toBe(2);
  });

  it("ignores non-POST requests (e.g. OPTIONS preflights)", () => {
    const baseEntry = makeEntry({ url: "https://api.githubcopilot.com/chat/completions" });
    const har = makeHar([
      baseEntry,
      { ...baseEntry, request: { ...baseEntry.request, method: "OPTIONS" } },
      { ...baseEntry, request: { ...baseEntry.request, method: "GET" } },
    ]);
    expect(extractAiCallCount(har)).toBe(1);
  });

  it("ignores non-2xx responses (e.g. 429 rate limits, 5xx errors)", () => {
    const baseEntry = makeEntry({ url: "https://api.githubcopilot.com/chat/completions" });
    const har = makeHar([
      baseEntry,
      { ...baseEntry, response: { ...baseEntry.response, status: 429, statusText: "Too Many Requests" } },
      { ...baseEntry, response: { ...baseEntry.response, status: 500, statusText: "Internal Server Error" } },
    ]);
    expect(extractAiCallCount(har)).toBe(1);
  });

  it("returns 0 for empty HAR", () => {
    const har = makeHar([]);
    expect(extractAiCallCount(har)).toBe(0);
  });
});
