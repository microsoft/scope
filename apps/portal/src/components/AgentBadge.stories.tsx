// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { AgentBadge } from "./AgentBadge";
import type { CodingAgent } from "@/types";

const activeAgent: CodingAgent = {
  _id: "coder-acp-copilot",
  name: "GitHub Copilot CLI",
  description: "GitHub Copilot coding agent",
  supportedModels: ["gpt-5.6-sol"],
  createdAt: "2026-01-01T00:00:00.000Z",
};

const meta = {
  component: AgentBadge,
  tags: ["ai-generated", "needs-work"],
  args: {
    agentId: activeAgent._id,
    agent: activeAgent,
  },
} satisfies Meta<typeof AgentBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Plain: Story = {
  play: async ({ canvas }) => {
    const link = canvas.getByRole("link", { name: activeAgent.name });
    await expect(link).toHaveAttribute("href", "/agents/coder-acp-copilot");
  },
};

export const Badge: Story = {
  args: { variant: "badge" },
};

export const WithVersion: Story = {
  args: { version: "copilot-1.2.3" },
};

export const Deleted: Story = {
  args: {
    agent: { ...activeAgent, deletedAt: "2026-02-01T00:00:00.000Z" },
  },
};

export const Unavailable: Story = {
  args: {
    agent: { ...activeAgent, available: false },
  },
};

export const SelectionControl: Story = {
  args: { triggerLink: false },
};

export const Unknown: Story = {
  args: {
    agentId: "missing-agent",
    agent: undefined,
  },
};
