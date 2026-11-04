// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { Badge } from "@/components/ui/badge";
import { TaxonomyStatus } from "./TaxonomyStatus";

const meta = {
  title: "Components/TaxonomyStatus",
  component: TaxonomyStatus,
} satisfies Meta<typeof TaxonomyStatus>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unavailable: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByLabelText("Taxonomy unavailable")).toBeVisible();
  },
};
export const Queued: Story = {
  args: { summary: { status: "queued", resultAvailable: false } },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Queued")).toBeVisible();
  },
};
export const Processing: Story = {
  args: { summary: { status: "processing", resultAvailable: false } },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Processing")).toHaveClass("animate-shimmer");
  },
};
export const Completed: Story = {
  args: { summary: { status: "done", resultAvailable: true } },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Completed")).toBeVisible();
  },
};
export const Failed: Story = {
  args: {
    summary: {
      status: "failed",
      resultAvailable: false,
      error: "Taxonome execution failed",
    },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Failed")).toBeVisible();
  },
};
export const ResultUnavailable: Story = {
  args: { summary: { status: "done", resultAvailable: false } },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Result unavailable")).toBeVisible();
  },
};
export const Historical: Story = {
  args: { summary: { status: "done", resultAvailable: true } },
  render: (args) => (
    <div className="flex items-center gap-2">
      <TaxonomyStatus {...args} />
      <Badge variant="outline">Historical</Badge>
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Historical")).toBeVisible();
    await expect(canvas.getByText("Completed")).toBeVisible();
  },
};
export const Deleted: Story = {
  args: { summary: { status: "done", resultAvailable: true } },
  render: (args) => (
    <div className="flex items-center gap-2">
      <TaxonomyStatus {...args} />
      <Badge variant="destructive">Deleted</Badge>
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Deleted")).toBeVisible();
    await expect(canvas.getByText("Completed")).toBeVisible();
  },
};
