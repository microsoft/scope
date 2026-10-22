// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";
import { ExperimentMembershipActions } from "./ExperimentMembershipActions";

const meta = {
  title: "Experiments/Membership Actions",
  component: ExperimentMembershipActions,
  args: {
    selectedCount: 2,
    busy: false,
    onCreate: fn(),
    onMove: fn(),
  },
} satisfies Meta<typeof ExperimentMembershipActions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EligibleStandaloneRuns: Story = {
  args: {
    eligibility: { eligible: true, assignedCount: 0 },
  },
  play: async ({ canvas, args }) => {
    await userEvent.click(
      canvas.getByRole("button", { name: "Create experiment" }),
    );
    await expect(args.onCreate).toHaveBeenCalledOnce();
    await expect(
      canvas.getByRole("button", { name: "Move to experiment" }),
    ).toBeEnabled();
  },
};

export const AssignedRunConflict: Story = {
  args: {
    eligibility: {
      eligible: false,
      assignedCount: 1,
      reason: "1 selected run is already assigned to an Experiment.",
    },
  },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText("1 selected run is already assigned to an Experiment."),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Create experiment" }),
    ).toBeDisabled();
    await expect(
      canvas.getByRole("button", { name: "Move to experiment" }),
    ).toBeDisabled();
  },
};
