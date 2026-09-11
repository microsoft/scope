// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortalChatClient, normalizeOpenAiChatBody } from "./llm-provider.js";

const body = { model: "gpt-4.1", messages: [{ role: "user" as const, content: "Hello" }], max_tokens: 512, temperature: 0.3 };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("provider HTTP transport", () => {
  it("omits deprecated Anthropic Sonnet 5 temperature while preserving Messages and output", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: "text", text: "criterion text" }],
    })));
    const result = await createPortalChatClient("anthropic", "https://api.anthropic.com/v1", "test-key")
      .path("/chat/completions").post({
        body: { ...body, model: "claude-sonnet-5", messages: [{ role: "system", content: "Write a criterion" }, ...body.messages] },
      });
    const request: unknown = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(request).toEqual({
      model: "claude-sonnet-5",
      system: "Write a criterion",
      messages: body.messages,
      max_tokens: 512,
    });
    expect(request).not.toHaveProperty("temperature");
    expect(result).toEqual({ status: "200", body: { choices: [{ message: { content: "criterion text" } }] } });
    expect(fetchSpy).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", expect.objectContaining({
      headers: expect.objectContaining({ "x-api-key": "test-key", "anthropic-version": "2023-06-01" }),
    }));
  });

  it.each([400, 401, 403, 404])("does not retry permanent HTTP %s or expose response secrets", async (status) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("test-key-private", { status }));
    await expect(createPortalChatClient("openai", "https://api.openai.com/v1", "test-key")
      .path("/chat/completions").post({ body })).rejects.toThrow(`HTTP ${status}`);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it.each([429, 503])("retries HTTP %s with the existing retry layer", async (status) => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] })));
    const pending = createPortalChatClient("openrouter", "https://openrouter.ai/api/v1", "test").path("/chat/completions").post({ body });
    await vi.runAllTimersAsync();
    expect((await pending).body.choices?.[0].message.content).toBe("done");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("uses OpenAI reasoning-model parameters without unsupported temperature", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] })));
    await createPortalChatClient("openai", "https://api.openai.com/v1", "test").path("/chat/completions").post({ body: { ...body, model: "gpt-5" } });
    const request: unknown = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(request).toMatchObject({ max_completion_tokens: 512 });
    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("max_tokens");
  });
});

describe("OpenAI reasoning parameter normalization", () => {
  it.each(["gpt-5", "gpt-5.4-mini", "o1", "o1-preview", "o3-mini", "o4-mini"])("normalizes recognized model %s without mutating the input", (model) => {
    const original = { ...body, model };
    expect(normalizeOpenAiChatBody(original)).toEqual({
      model, messages: body.messages, max_completion_tokens: 512,
    });
    expect(original).toEqual({ ...body, model });
  });

  it.each(["gpt-4.1", "gpt-50", "custom-deployment"])("preserves the complete legacy request for %s", (model) => {
    const original = { ...body, model };
    expect(normalizeOpenAiChatBody(original)).toBe(original);
  });
});
