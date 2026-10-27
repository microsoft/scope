// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { TurnTimeline } from "./TurnTimeline";
import type { ConversationTurn } from "@/types";

/** Build a minimal completed turn for the timeline. */
function makeTurn(iteration: number, overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    iteration,
    judgeFeedback: `Feedback for iteration ${iteration}`,
    snapshotUrl: `https://blob/snapshot-${iteration}.tar.gz`,
    passed: false,
    timestamp: "2026-01-01T10:00:00.000Z",
    durationMs: 65_000,
    ...overrides,
  };
}

const meta = {
  component: TurnTimeline,
  tags: ["ai-generated"],
  args: {
    runId: "run-123",
    turns: [
      makeTurn(1, { workspaceSizeBytes: 3 * 1024 * 1024 }),
      makeTurn(2, { workspaceSizeBytes: 1.2 * 1024 ** 3, passed: true }),
    ],
  },
} satisfies Meta<typeof TurnTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Each iteration shows its compressed workspace snapshot size (#1564). */
export const WithSnapshotSizes: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText("3.0 MB")).toBeInTheDocument();
    await expect(canvas.getByText("1.2 GB")).toBeInTheDocument();
  },
};

/** Legacy/imported runs have no recorded size — shown as unavailable, never 0 B. */
export const LegacyWithoutSizes: Story = {
  args: {
    turns: [makeTurn(1), makeTurn(2, { passed: true })],
  },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByText("size unavailable")).toHaveLength(2);
  },
};
