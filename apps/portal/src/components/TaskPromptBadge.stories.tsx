// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent } from "storybook/test";
import { TaskPromptBadge } from "./TaskPromptBadge";
import type { TaskPrompt } from "@/types";

const basePrompt: TaskPrompt = {
  _id: "abcdef1234567890",
  text: "When creating a REST API, use TypeScript and Express. Add input validation.",
  createdAt: "2026-01-01T00:00:00.000Z",
  features: [
    { featureId: "validation", detected: true, evaluated: true },
    { featureId: "auth", detected: false, evaluated: true },
  ],
};

const meta = {
  component: TaskPromptBadge,
  tags: ["ai-generated", "needs-work"],
  args: {
    taskPromptId: basePrompt._id,
    prompt: basePrompt,
  },
} satisfies Meta<typeof TaskPromptBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SelectPrompt: Story = {
  args: { prompt: { ...basePrompt, type: "select" } },
  play: async ({ canvas }) => {
    const link = canvas.getByRole("link");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/task-prompts/abcdef1234567890");
    await expect(link.textContent).toContain("Requirements");
  },
};

export const BuildGatePrompt: Story = {
  args: { prompt: { ...basePrompt, type: "build" } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("link").textContent).toContain("Build");
  },
};

export const AgentsMdPrompt: Story = {
  args: { prompt: { ...basePrompt, type: "agents.md" } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("link").textContent).toContain("AGENTS.md");
  },
};

export const LegacyUntypedPrompt: Story = {
  args: { prompt: { ...basePrompt, type: undefined } },
  play: async ({ canvas }) => {
    // Legacy untyped prompts fall back to the Requirements (select) label.
    await expect(canvas.getByRole("link").textContent).toContain("Requirements");
  },
};

export const CustomChildren: Story = {
  args: {
    children: <span className="text-sm font-medium">Implement a Snake game</span>,
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Implement a Snake game")).toBeVisible();
  },
};

export const NoFeatures: Story = {
  args: { prompt: { ...basePrompt, type: "select", features: undefined } },
};

export const BlobBacked: Story = {
  // Body is loaded lazily on hover (text undefined); the badge still renders.
  args: { prompt: { ...basePrompt, type: "test", text: undefined } },
};

export const NonLinking: Story = {
  args: { link: false, prompt: { ...basePrompt, type: "run" } },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("link")).toBeNull();
  },
};

const legacyTask =
  "Build a benchmarking dashboard that compares coding agents, displays evaluation criteria, streams logs, supports project filters, and explains all results with clear accessible interactions.";

export const LegacyRunWithoutPromptReference: Story = {
  parameters: {
    docs: {
      description: {
        story: "Shows the full inline task with the same 200 ms hover delay as the existing run metadata tooltips.",
      },
    },
  },
  args: {
    taskPromptId: undefined,
    prompt: undefined,
    fallbackText: legacyTask,
    children: <span>Build a benchmarking dashboard…</span>,
  },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("link")).toBeNull();
    const trigger = canvas.getByText("Build a benchmarking dashboard…");
    await userEvent.hover(trigger);
    await expect(await screen.findByRole("tooltip")).toHaveTextContent(legacyTask);
    await userEvent.unhover(trigger);
  },
};
