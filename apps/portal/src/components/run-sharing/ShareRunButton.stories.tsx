// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { http, HttpResponse } from "msw";
import { AuthContext } from "@/contexts/AuthContext";
import { signedOutAuth } from "@/contexts/authFixtures";
import { ShareRunButton } from "./ShareRunDialog";

const meta = {
  component: ShareRunButton,
  tags: ["ai-generated", "needs-work"],
  args: { requestId: "demo-request", runId: "demo-attempt", attemptNumber: 1 },
  parameters: {
    msw: { handlers: [
      http.get("/api/v1/version", () => HttpResponse.json({ commit: "demo", buildTime: "demo", runSharingEnabled: true })),
      http.get("/api/v1/requests/demo-request/runs/demo-attempt/shares", () => HttpResponse.json({ data: [], next: null })),
    ] },
  },
} satisfies Meta<typeof ShareRunButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignedInPublisher: Story = {
  play: async ({ canvas }) => { await expect(await canvas.findByRole("button", { name: "Share" })).toBeVisible(); },
};
export const SignedOut: Story = {
  decorators: [(Story) => <AuthContext.Provider value={signedOutAuth}><Story /></AuthContext.Provider>],
  play: async ({ canvas }) => { await expect(canvas.queryByRole("button", { name: "Share" })).toBeNull(); },
};
export const Disabled: Story = {
  parameters: {
    msw: { handlers: [http.get("/api/v1/version", () => HttpResponse.json({ commit: "demo", buildTime: "demo", runSharingEnabled: false }))] },
  },
};
