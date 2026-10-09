// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent, within } from "storybook/test";
import { ServerAgentSetupView } from "./ServerAgentSetup";

const meta = {
  component: ServerAgentSetupView,
  tags: ["ai-generated", "needs-work"],
  args: {
    agents: [
      { workerType: "coder-acp-copilot-host", label: "Copilot host", runtime: "host", enabled: false, available: false },
      { workerType: "coder-acp-claude-code", label: "Claude Docker", runtime: "docker", enabled: false, available: false },
    ],
    onConfigure: fn(),
  },
} satisfies Meta<typeof ServerAgentSetupView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const HostConsent: Story = {
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Set up local agents" }));
    const card = within(screen.getByRole("region", { name: "Copilot host" }));
    const enable = card.getByRole("button", { name: "Enable Copilot host" });
    await expect(enable).toBeDisabled();
    await userEvent.click(card.getByRole("checkbox"));
    await expect(enable).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
  },
};

export const SetupFailure: Story = {
  args: {
    error: "The selected CLI is not installed. Choose an executable or use Docker.",
  },
};
