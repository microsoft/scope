// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { CliCommand } from "./CliCommand";
import {
  buildRunGet,
  buildRunList,
  buildRunSubmit,
  buildRunBulk,
} from "@/lib/cli/buildCommand";

const meta = {
  component: CliCommand,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof CliCommand>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Simple single-command modal (e.g. a run detail page). */
export const RunGet: Story = {
  args: { command: buildRunGet("req_12345") },
  play: async ({ canvas }) => {
    const trigger = canvas.getByRole("button", { name: /show cli equivalent/i });
    await expect(trigger).toBeInTheDocument();
    await userEvent.click(trigger);
  },
};

/** List command reflecting active filters, with a parity note. */
export const RunListWithNote: Story = {
  args: {
    command: buildRunList({
      worker: "coder-vscode-web",
      turns: "5",
      turnsOp: "gte",
      unsupportedFilters: ["status", "outcome", "model"],
    }),
  },
};

/** Labeled trigger used in the Submit Run footer. */
export const SubmitLabeled: Story = {
  args: {
    label: "CLI",
    title: "Submit from the CLI",
    command: buildRunSubmit({
      task: "Create a Snake game using React",
      criteria: ["has-tests"],
      worker: "coder-acp-claude-code",
      model: "claude-sonnet-4.5",
      occurrences: 5,
    }),
  },
};

/** Bulk action over a multi-id selection (loop form). */
export const BulkLoop: Story = {
  args: {
    title: "Bulk action from the CLI",
    command: buildRunBulk("delete", ["req_a", "req_b", "req_c"]),
  },
};
