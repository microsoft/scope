// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { expect, screen, userEvent } from "storybook/test";
import { PortalAiSettings } from "./PortalAiSettings";
import type { KeyDocument } from "@/types";

const providerKeys: KeyDocument[] = [
  { _id: "openai-key", type: "openai-api-key", comment: "Authoring OpenAI", capabilities: ["openai-api"],
    secretName: "metadata-only", enabled: true, lastValidationStatus: "valid", acquireCount: 0, createdAt: "2026-09-01T00:00:00Z" },
  { _id: "anthropic-key", type: "anthropic-api-key", comment: "Existing Claude key", capabilities: ["anthropic-api", "claude-code-cli"],
    secretName: "metadata-only-claude", enabled: true, lastValidationStatus: "valid", acquireCount: 0, createdAt: "2026-09-01T00:00:00Z" },
];
const meta = {
  title: "Secrets/Portal AI",
  component: PortalAiSettings,
  tags: ["ai-generated", "needs-work"],
  args: { keys: providerKeys },
  decorators: [(Story) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Story /></QueryClientProvider>],
  parameters: {
    msw: { handlers: [
      http.get("*/api/v1/keys/portal-ai", () => HttpResponse.json({ provider: "auto" })),
      http.put("*/api/v1/keys/portal-ai", async ({ request }) => HttpResponse.json(await request.json())),
    ] },
  },
} satisfies Meta<typeof PortalAiSettings>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Automatic: Story = {};
export const SelectOpenAI: Story = {
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("combobox", { name: "Provider" }));
    await userEvent.click(await screen.findByRole("option", { name: /^OpenAI$/ }));
    await userEvent.click(canvas.getByRole("combobox", { name: "Credential" }));
    await userEvent.click(await screen.findByRole("option", { name: "Authoring OpenAI" }));
    await userEvent.type(canvas.getByLabelText("Model override (optional)"), "gpt-4.1-mini");
    await userEvent.click(canvas.getByRole("button", { name: "Save Portal AI" }));
    await expect(await canvas.findByText("Portal AI settings saved.")).toBeVisible();
  },
};
export const AnthropicExistingKey: Story = {
  parameters: { msw: { handlers: [
    http.get("*/api/v1/keys/portal-ai", () => HttpResponse.json({ provider: "anthropic", keyId: "anthropic-key" })),
  ] } },
};
export const NoCredentials: Story = {
  args: { keys: [] },
  parameters: { msw: { handlers: [
    http.get("*/api/v1/keys/portal-ai", () => HttpResponse.json({ provider: "openrouter" })),
  ] } },
};
