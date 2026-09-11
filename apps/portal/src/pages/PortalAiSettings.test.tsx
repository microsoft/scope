// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import { MemoryRouter } from "react-router-dom";
import * as settingsStories from "./PortalAiSettings.stories";
import * as createStories from "./CreateToken.stories";

const requests = vi.hoisted(() => ({ settings: vi.fn(), preview: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ apiClient: requests.settings }));
vi.mock("@/lib/api", () => ({
  api: { previewKey: requests.preview, createKey: vi.fn() },
}));

beforeEach(() => {
  requests.settings.mockImplementation(async (_path: string, options: { json?: unknown }) =>
    new Response(JSON.stringify(options.json ?? { provider: "auto" })));
  requests.preview.mockResolvedValue({ status: "valid", capabilities: ["openai-api"] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const { SelectOpenAI } = composeStories(settingsStories);
const { OpenAI, OpenRouter, Compatible } = composeStories(createStories);

describe("Secrets provider stories", () => {
  it("saves an explicit provider, credential and model using the authenticated API transport", async () => {
    const { container } = render(<SelectOpenAI />);
    await settingsStories.SelectOpenAI.play?.({ canvas: within(container) } as Parameters<NonNullable<typeof settingsStories.SelectOpenAI.play>>[0]);
    expect(requests.settings).toHaveBeenLastCalledWith("/api/v1/keys/portal-ai", {
      method: "PUT", json: { provider: "openai", keyId: "openai-key", model: "gpt-4.1-mini" },
    });
  });
  it("previews a structured OpenAI secret with endpoint and model presets", async () => {
    const { container } = render(<MemoryRouter><OpenAI /></MemoryRouter>);
    await createStories.OpenAI.play?.({ canvas: within(container) } as Parameters<NonNullable<typeof createStories.OpenAI.play>>[0]);
    expect(requests.preview).toHaveBeenCalledWith({
      type: "openai-api-key",
      value: JSON.stringify({ endpoint: "https://api.openai.com/v1", apiKey: "test-story-not-a-real-key", model: "gpt-4.1" }),
    });
  });
  it("presents OpenRouter's qualified model preset", async () => {
    const { container } = render(<MemoryRouter><OpenRouter /></MemoryRouter>);
    await createStories.OpenRouter.play?.({ canvas: within(container) } as Parameters<NonNullable<typeof createStories.OpenRouter.play>>[0]);
  });
  it("requires endpoint, key and model for compatible endpoints", async () => {
    const { container } = render(<MemoryRouter><Compatible /></MemoryRouter>);
    await createStories.Compatible.play?.({ canvas: within(container) } as Parameters<NonNullable<typeof createStories.Compatible.play>>[0]);
  });
});
