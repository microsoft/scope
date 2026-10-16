// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { SubmissionLink } from "./SubmissionLink";

const meta = {
  component: SubmissionLink,
  tags: ["ai-generated", "needs-work"],
  args: {
    submissionId: "abcdef12-3456-7890-abcd-ef1234567890",
    projectId: "project-alpha",
  },
} satisfies Meta<typeof SubmissionLink>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("link", { name: /view submission/i })).toHaveAttribute(
      "href",
      "/runs?projectId=project-alpha&submissionId=abcdef12-3456-7890-abcd-ef1234567890&groupBy=profile",
    );
    await expect(canvas.getByRole("button", { name: /copy link to submission/i })).toBeVisible();
    await expect(canvas.getByText("abcdef12")).toBeVisible();
  },
};
