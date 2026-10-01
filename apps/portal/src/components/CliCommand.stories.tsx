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

/** List command reflecting the active filters and sort. */
export const RunListFiltered: Story = {
  args: {
    command: buildRunList({
      workers: ["coder-vscode-web"],
      statuses: ["done"],
      outcomes: ["failed"],
      turns: "5",
      turnsOp: "gte",
      sortBy: "duration",
      sortDir: "desc",
    }),
  },
};

/** Labeled trigger used in the Submit Run footer, with a parity note. */
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
      priority: 3,
    }),
  },
};

/** Base profile + variations: the variations go through a JSON file. */
export const SubmitProfileVariations: Story = {
  args: {
    label: "CLI",
    title: "Submit from the CLI",
    command: buildRunSubmit({
      task: "Create a Snake game using React",
      criteria: ["has-tests"],
      baseProfileId: "prof_base@2",
      profileVariations: ["prof_fast", "prof_thorough@4"],
      occurrences: 3,
    }),
  },
};

/** Bulk delete over a multi-id selection (loop form). */
export const BulkLoop: Story = {
  args: {
    title: "Bulk action from the CLI",
    command: buildRunBulk("delete", ["req_a", "req_b", "req_c"]),
  },
};
