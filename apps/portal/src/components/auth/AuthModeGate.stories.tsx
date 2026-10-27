// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect } from "storybook/test";
import { AuthModeGate } from "./AuthModeGate";

const meta = {
  component: AuthModeGate,
  tags: ["ai-generated", "needs-work"],
  args: { children: <p>Scope application</p>, expectedEnabled: false },
  parameters: { msw: { handlers: [
    http.get("/api/v1/version", () => HttpResponse.json({ authEnabled: false })),
  ] } },
} satisfies Meta<typeof AuthModeGate>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AnonymousDeployment: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("Scope application")).toBeVisible();
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
  },
};
export const MismatchedDeployment: Story = {
  args: { expectedEnabled: true },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Authentication configuration unavailable or mismatched");
    await expect(canvas.queryByText("Scope application")).not.toBeInTheDocument();
  },
};
export const MissingMode: Story = {
  parameters: { msw: { handlers: [
    http.get("/api/v1/version", () => HttpResponse.json({})),
  ] } },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("alert")).toBeVisible();
    await expect(canvas.queryByText("Scope application")).not.toBeInTheDocument();
  },
};
