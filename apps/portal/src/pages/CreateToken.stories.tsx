// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { expect, screen, userEvent } from "storybook/test";
import { CreateToken } from "./CreateToken";

const meta = {
  title: "Secrets/Register provider",
  component: CreateToken,
  tags: ["ai-generated", "needs-work"],
  decorators: [(Story) => <QueryClientProvider client={new QueryClient()}><Story /></QueryClientProvider>],
  parameters: { msw: { handlers: [
    http.post("*/api/v1/keys/preview", () => HttpResponse.json({ status: "valid", capabilities: ["openai-api"] })),
  ] } },
} satisfies Meta<typeof CreateToken>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OpenAI: Story = {
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("combobox", { name: "Key Type" }));
    await userEvent.click(await screen.findByRole("option", { name: /^OpenAI OpenAI API$/ }));
    await expect(canvas.getByLabelText("Endpoint URL")).toHaveValue("https://api.openai.com/v1");
    await expect(canvas.getByLabelText(/Deployment \/ Model name/)).toHaveValue("gpt-4.1");
    await userEvent.type(canvas.getByLabelText("API Key", { exact: true }), "test-story-not-a-real-key");
    await userEvent.click(canvas.getByRole("button", { name: /Validate & Preview/ }));
    await expect(await canvas.findByText("Review Detected Capabilities")).toBeVisible();
  },
};
export const OpenRouter: Story = {
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("combobox", { name: "Key Type" }));
    await userEvent.click(await screen.findByRole("option", { name: /^OpenRouter OpenRouter API$/ }));
    await expect(canvas.getByLabelText("Endpoint URL")).toHaveValue("https://openrouter.ai/api/v1");
    await expect(canvas.getByLabelText(/Deployment \/ Model name/)).toHaveValue("openai/gpt-4.1");
  },
};
export const Compatible: Story = {
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("combobox", { name: "Key Type" }));
    await userEvent.click(await screen.findByRole("option", { name: /^OpenAI-compatible endpoint/ }));
    await expect(canvas.getByRole("button", { name: /Validate & Preview/ })).toBeDisabled();
    await expect(canvas.getByLabelText(/Deployment \/ Model name/)).toHaveValue("");
  },
};
