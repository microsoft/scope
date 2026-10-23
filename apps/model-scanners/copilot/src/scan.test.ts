// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { scanCopilotModels } from "./scan.js";

describe("scanCopilotModels", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should parse model IDs from .data[] response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "gpt-4.1", name: "GPT-4.1", extra_field: "ignored" },
            { id: "claude-sonnet-4", object: "model", another: 123 },
            { id: "o3-mini", created_at: "2025-01-15T00:00:00Z" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await scanCopilotModels("test-token");

    expect(result.provider).toBe("github-copilot");
    expect(result.models).toHaveLength(3);
    expect(result.models.map((m) => m.id)).toEqual([
      "gpt-4.1",
      "claude-sonnet-4",
      "o3-mini",
    ]);
    expect(result.scannedAt).toBeInstanceOf(Date);
  });

  it("should extract providerAvailableFrom from created_at", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "gpt-4.1", created_at: "2025-06-01T00:00:00Z" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await scanCopilotModels("test-token");

    expect(result.models[0].providerAvailableFrom).toEqual(new Date("2025-06-01T00:00:00Z"));
  });

  it("should extract providerEndOfLife from deprecation_date", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "gpt-4o", deprecation_date: "2026-12-31T00:00:00Z" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await scanCopilotModels("test-token");

    expect(result.models[0].providerEndOfLife).toEqual(new Date("2026-12-31T00:00:00Z"));
  });

  it("should skip entries without a valid id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "valid-model" },
            { id: "" },
            { id: 123 },
            { name: "no-id" },
            null,
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await scanCopilotModels("test-token");

    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe("valid-model");
  });

  it("should handle empty data array", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ data: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await scanCopilotModels("test-token");

    expect(result.models).toHaveLength(0);
    expect(result.provider).toBe("github-copilot");
  });

  it("should handle response as plain array (fallback)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: "model-a" },
          { id: "model-b" },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await scanCopilotModels("test-token");

    expect(result.models).toHaveLength(2);
    expect(result.models.map((m) => m.id)).toEqual(["model-a", "model-b"]);
  });

  it("should send correct headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    await scanCopilotModels("my-github-token");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.githubcopilot.com/models");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer my-github-token",
    );
    expect(
      (init?.headers as Record<string, string>)["Copilot-Integration-Id"],
    ).toBe("vscode-chat");
  });

  it("should omit Authorization and use the injected fetch when token is null", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "claude-opus-4" }] }), { status: 200 }),
    );

    const result = await scanCopilotModels(null, fetchFn);

    expect(globalFetch).not.toHaveBeenCalled();
    expect(result.models.map((m) => m.id)).toEqual(["claude-opus-4"]);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.githubcopilot.com/models");
    const headers = init?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers["Copilot-Integration-Id"]).toBe("vscode-chat");
  });

  it("should throw on 401 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );

    await expect(scanCopilotModels("bad-token")).rejects.toThrow(
      "Copilot models API returned HTTP 401",
    );
  });

  it("should throw on 500 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Server Error", { status: 500 }),
    );

    await expect(scanCopilotModels("token")).rejects.toThrow(
      "Copilot models API returned HTTP 500",
    );
  });

  it("should throw on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network failure"));

    await expect(scanCopilotModels("token")).rejects.toThrow("Network failure");
  });

  it("should capture name and version in metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "gpt-4.1", name: "GPT 4.1", version: "2025-04-14" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await scanCopilotModels("token");

    expect(result.models[0].metadata).toEqual({
      name: "GPT 4.1",
      version: "2025-04-14",
    });
  });

  it("should extract capabilities from capabilities.supports", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "claude-opus-4.7",
              capabilities: {
                supports: {
                  reasoning_effort: ["medium"],
                  tool_calls: true,
                  vision: true,
                  streaming: true,
                  adaptive_thinking: true,
                  max_thinking_budget: 32000,
                },
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await scanCopilotModels("token");

    expect(result.models[0].capabilities).toEqual({
      reasoningEffort: ["medium"],
      toolCalls: true,
      vision: true,
      streaming: true,
      adaptiveThinking: true,
      maxThinkingBudget: 32000,
    });
  });

  it("should extract multiple reasoning effort levels", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "gpt-5.5",
              capabilities: {
                supports: {
                  reasoning_effort: ["none", "low", "medium", "high", "xhigh"],
                  tool_calls: true,
                },
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await scanCopilotModels("token");

    expect(result.models[0].capabilities?.reasoningEffort).toEqual([
      "none", "low", "medium", "high", "xhigh",
    ]);
  });

  it("should not include capabilities when capabilities.supports is absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "model-no-caps" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await scanCopilotModels("token");

    expect(result.models[0].capabilities).toBeUndefined();
  });
});
