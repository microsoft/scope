// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortalChatClient } from "./llm-provider.js";

const body = { model: "gpt-4.1", messages: [{ role: "user" as const, content: "Hello" }], max_tokens: 512, temperature: 0.3 };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("provider HTTP transport", () => {
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
