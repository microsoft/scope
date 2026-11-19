// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { HarWebSocketMessages } from "./HarWebSocketMessages";

const start = Date.UTC(2026, 5, 21, 12) / 1000;

const meta = {
  component: HarWebSocketMessages,
  tags: ["ai-generated", "needs-work"],
  decorators: [
    (Story) => (
      <div className="max-w-xl text-xs">
        <Story />
      </div>
    ),
  ],
  args: {
    messages: [
      { type: "send", time: start, opcode: 1, data: JSON.stringify({ op: "subscribe", channel: "runs" }) },
      { type: "receive", time: start + 0.12, opcode: 1, data: JSON.stringify({ op: "ack" }) },
      { type: "receive", time: start + 1.5, opcode: 1, data: JSON.stringify({ op: "event", data: { status: "running" } }) },
      { type: "send", time: start + 2, opcode: 1, data: "ping" },
      { type: "receive", time: start + 2.01, opcode: 2, data: btoa(String.fromCharCode(0xff, 0xfe, 0x00, 0x81)) },
    ],
  },
} satisfies Meta<typeof HarWebSocketMessages>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Frames in both directions, including a binary frame shown as base64. */
export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/2 sent · 3 received/)).toBeVisible();
    await expect(canvas.getAllByRole("listitem")).toHaveLength(5);

    // The direction filter narrows the list to received frames only.
    await userEvent.click(canvas.getByRole("button", { name: "Received" }));
    await expect(canvas.getAllByRole("listitem")).toHaveLength(3);
  },
};

/** A connection that opened but recorded no frames. */
export const Empty: Story = {
  args: { messages: [] },
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/no messages recorded/i)).toBeVisible();
  },
};
