// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, screen, waitFor } from "storybook/test";
import { toast } from "sonner";
import { Toaster } from "./sonner";
import { Button } from "./button";

const meta = {
  component: Toaster,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof Toaster>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div>
      <Button onClick={() => toast.success("Run submitted", { description: "3 iterations queued." })}>
        Show toast
      </Button>
      <Toaster />
    </div>
  ),
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: /show toast/i }));
    await waitFor(async () => {
      await expect(screen.getByText("Run submitted")).toBeVisible();
    });
  },
};

export const NoMatchingReportTemplates: Story = {
  render: () => (
    <div>
      <Button onClick={() => toast.info("No report templates matched this run", {
        description: "No report was queued. Check the active report templates and their triggers.",
      })}>
        Show no-match feedback
      </Button>
      <Toaster />
    </div>
  ),
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Show no-match feedback" }));
    await waitFor(async () => {
      await expect(screen.getByText("No report templates matched this run")).toBeVisible();
    });
  },
};
