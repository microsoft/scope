// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor } from "storybook/test";
import { TooltipProvider } from "@/components/ui/tooltip";
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
  decorators: [
    (Story) => (
      <TooltipProvider>
        <Story />
      </TooltipProvider>
    ),
  ],
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
    await expect(screen.getByRole("button", { name: "Copy install command" })).toBeInTheDocument();
    await expect(screen.getByRole("button", { name: "Copy environment variables" })).toBeInTheDocument();
    await expect(screen.getByRole("button", { name: "Copy cli command" })).toBeInTheDocument();
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

/** Multiline instructions and parity notes must stay reachable in short viewports. */
export const SubmitLongContent: Story = {
  args: {
    label: "CLI",
    title: "Submit from the CLI",
    command: buildRunSubmit({
      task: "Create a Snake game using React",
      criteria: ["has-tests", "keyboard-controls"],
      worker: "coder-acp-copilot",
      model: "gpt-5",
      reasoningEffort: "high",
      maxIterations: 20,
      occurrences: 3,
      skills: ["typescript", "accessibility"],
      agentsMd: [
        "# Project instructions",
        ...Array.from({ length: 30 }, (_, i) => `- Requirement ${i + 1}: Keep keyboard controls accessible and tested.`),
      ].join("\n"),
      priority: 3,
    }),
  },
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: /show cli equivalent/i }));

    const dialog = screen.getByRole("dialog");
    const close = screen.getByRole("button", { name: "Close" });
    const docs = screen.getByRole("link", { name: "Read the CLI documentation" });
    const expectInViewport = (element: HTMLElement) => {
      const bounds = element.getBoundingClientRect();
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
    };

    await waitFor(() => {
      expectInViewport(dialog);
      expectInViewport(close);
    });
    await expect(screen.getByText(/Requirement 30:/)).toBeInTheDocument();
    await expect(screen.getByText(/Priority \(3\)/)).toBeInTheDocument();

    docs.focus();
    await waitFor(() => {
      expectInViewport(docs);
      expectInViewport(close);
      expectInViewport(screen.getByRole("heading", { name: "Submit from the CLI" }));
    });
  },
};

/** Bulk delete over a multi-id selection (loop form). */
export const BulkLoop: Story = {
  args: {
    title: "Bulk action from the CLI",
    command: buildRunBulk("delete", ["req_a", "req_b", "req_c"]),
  },
};
