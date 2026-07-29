// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import { extractHarMetadata } from "./extract-metadata.js";
import type { HarFile } from "./types.js";

/** Minimal HAR with no entries. */
function emptyHar(): HarFile {
  return {
    log: {
      version: "1.2",
      creator: { name: "test", version: "0.0.0" },
      entries: [],
    },
  };
}

/** HAR with a single AI completion response containing tool calls and token usage. */
function harWithToolCallsAndUsage(): HarFile {
  return {
    log: {
      version: "1.2",
      creator: { name: "test", version: "0.0.0" },
      entries: [
        {
          startedDateTime: "2026-04-27T00:00:00Z",
          time: 100,
          request: {
            method: "POST",
            url: "https://api.githubcopilot.com/chat/completions",
            httpVersion: "HTTP/2",
            headers: [],
            queryString: [],
            headersSize: -1,
            bodySize: -1,
          },
          response: {
            status: 200,
            statusText: "OK",
            httpVersion: "HTTP/2",
            headers: [],
            content: {
              size: 500,
              mimeType: "application/json",
              text: JSON.stringify({
                choices: [
                  {
                    message: {
                      role: "assistant",
                      tool_calls: [
                        {
                          id: "call_1",
                          type: "function",
                          function: {
                            name: "read_file",
                            arguments: '{"path": "src/index.ts"}',
                          },
                        },
                      ],
                    },
                  },
                ],
                usage: {
                  prompt_tokens: 100,
                  completion_tokens: 50,
                  total_tokens: 150,
                },
              }),
            },
            headersSize: -1,
            bodySize: -1,
            redirectURL: "",
          },
        },
      ],
    },
  };
}

describe("extractHarMetadata", () => {
  it("returns empty result for HAR with no entries", async () => {
    const log = vi.fn();
    const result = await extractHarMetadata(emptyHar(), "/tmp/test.har", log);

    expect(result).toEqual({
      harFilePath: "/tmp/test.har",
      tokenUsage: undefined,
      aiCallCount: 0,
    });
    expect(log).toHaveBeenCalledWith(
      "info",
      "Extracted 0 tool calls from HAR",
      expect.objectContaining({ toolCallCount: 0 }),
    );
    expect(log).toHaveBeenCalledWith("info", "AI call count: 0");
  });

  it("extracts tool calls, token usage, and AI call count", async () => {
    const log = vi.fn();
    const result = await extractHarMetadata(harWithToolCallsAndUsage(), "/tmp/test.har", log);

    expect(result.harFilePath).toBe("/tmp/test.har");
    expect(result.tokenUsage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
    expect(result.aiCallCount).toBe(1);

    expect(log).toHaveBeenCalledWith(
      "info",
      "Extracted 1 tool calls from HAR",
      expect.objectContaining({
        toolCallCount: 1,
        toolNames: ["read_file"],
      }),
    );
    expect(log).toHaveBeenCalledWith(
      "info",
      "Token usage: 100 prompt, 50 completion, 150 total",
    );
    expect(log).toHaveBeenCalledWith("info", "AI call count: 1");
  });

  it("passes through null harFilePath", async () => {
    const log = vi.fn();
    const result = await extractHarMetadata(emptyHar(), null, log);

    expect(result.harFilePath).toBeNull();
  });

  it("omits tokenUsage when HAR has no usage data", async () => {
    const log = vi.fn();
    const result = await extractHarMetadata(emptyHar(), null, log);

    expect(result.tokenUsage).toBeUndefined();
    // Should NOT have logged token usage
    const tokenLogCalls = log.mock.calls.filter(
      (args) => typeof args[1] === "string" && args[1].startsWith("Token usage:"),
    );
    expect(tokenLogCalls).toHaveLength(0);
  });
});
