// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { SharedRunView, SharedRunUnavailable } from "./SharedRunView";
import { summaryRun, fullRun } from "./fixtures";

const meta = {
  component: SharedRunView,
  tags: ["ai-generated", "needs-work"],
  args: { data: summaryRun },
} satisfies Meta<typeof SharedRunView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Summary: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Shared run · Read-only")).toBeVisible();
    await expect(canvas.queryByRole("tab", { name: "Prompts" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Retry" })).toBeNull();
  },
};

export const FullDetail: Story = {
  args: { data: fullRun, logs: <p>Persisted logs appear here.</p>, reports: <p>Shared reports appear here.</p> },
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("tab", { name: "Prompts" }));
    await expect(canvas.getByText(fullRun.prompts![0].text!)).toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Conversations" }));
    await expect(canvas.getByText(fullRun.run.turns[0].codingAgentResponse!)).toBeVisible();
  },
};

export const Artifacts: Story = {
  args: {
    data: {
      ...fullRun, content: { ...fullRun.content, video: true, snapshots: true },
      artifacts: [
        { id: "video-0", label: "Run video", category: "video", contentType: "video/webm" },
        { id: "iteration-1-snapshot", label: "Iteration 1 workspace", category: "snapshots", contentType: "application/gzip" },
      ],
    },
  },
};

export const Running: Story = {
  args: { data: { ...summaryRun, run: { ...summaryRun.run, status: "processing", outcome: undefined, durationMs: undefined, turns: [] } } },
};

export const UnavailablePrompt: Story = {
  args: { data: { ...fullRun, prompts: [{ label: "AGENTS.md", text: null }] } },
};

export const UnavailableLink: Story = {
  render: () => <SharedRunUnavailable />,
};
