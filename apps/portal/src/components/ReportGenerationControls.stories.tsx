// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";
import { ReportGenerationControls } from "./ReportGenerationControls";

const meta = {
  component: ReportGenerationControls,
  tags: ["ai-generated", "needs-work"],
  args: { loading: false, error: false, pending: false, onGenerate: fn(), onRetry: fn() },
} satisfies Meta<typeof ReportGenerationControls>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NoTemplates: Story = {
  args: { eligibility: { activeTemplateCount: 0, templates: [] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Generate Report" })).toBeDisabled();
    await expect(canvas.getByRole("link", { name: "Configure report templates" })).toHaveAttribute("href", "/reports/templates");
  },
};

export const NoMatchingTriggers: Story = {
  args: { eligibility: { activeTemplateCount: 3, templates: [] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Generate Report" })).toBeDisabled();
    await expect(canvas.getByText(/No active report template triggers match/)).toBeVisible();
  },
};

export const MatchingTemplates: Story = {
  args: { eligibility: { activeTemplateCount: 3, templates: [
    { id: "quality", name: "Quality review" },
    { id: "features", name: "Prompt feature analysis" },
  ] } },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole("listitem")).toHaveLength(2);
    await expect(canvas.getByRole("button", { name: "Generate Report" })).toBeEnabled();
    await userEvent.click(canvas.getByRole("button", { name: "Generate Report" }));
  },
};

export const Loading: Story = { args: { loading: true } };
export const CheckFailed: Story = { args: { error: true } };
export const Generating: Story = { args: { ...MatchingTemplates.args, pending: true } };
