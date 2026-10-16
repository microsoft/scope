// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { SubmissionLink } from "./SubmissionLink";

const meta = {
  title: "Submissions/SubmissionLink",
  component: SubmissionLink,
  args: {
    submissionId: "submission-12345678",
  },
} satisfies Meta<typeof SubmissionLink>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Labeled: Story = {
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("link", {
        name: "Open submission submission-12345678",
      }),
    ).toBeVisible();
    await expect(canvas.getByText("Submission")).toBeVisible();
  },
};

export const Compact: Story = {
  args: { compact: true },
};
