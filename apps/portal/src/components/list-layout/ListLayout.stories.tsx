// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent } from "storybook/test";
import { ListLayout } from "./ListLayout";

const meta = {
  title: "Layout/ListLayout",
  component: ListLayout,
  tags: ["ai-generated", "needs-work"],
  parameters: {
    layout: "fullscreen",
  },
  args: {
    title: "Runs",
    description: "Benchmark runs and processing history",
    filterRail: <div className="p-4">Run filters</div>,
    railStorageKey: "runs",
    children: <div>Run table</div>,
  },
} satisfies Meta<typeof ListLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Runs: Story = {
  play: async ({ canvas }) => {
    const trigger = canvas.getByLabelText("Open filters");
    await expect(trigger.querySelector(".lucide-list")).toBeTruthy();
    await expect(trigger).toHaveAttribute("title", "Open filters");

    if (window.matchMedia("(max-width: 1023.98px)").matches) {
      await userEvent.click(trigger);
      await expect(screen.getByRole("dialog", { name: "Filters" })).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
    }
  },
};

export const Reports: Story = {
  args: {
    title: "Reports",
    description: "Generated benchmark reports",
    filterRail: <div className="p-4">Report filters</div>,
    railStorageKey: "reports",
    children: <div>Report table</div>,
  },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByLabelText("Open filters").querySelector(".lucide-file-text"),
    ).toBeTruthy();
  },
};

export const UnknownSection: Story = {
  args: {
    title: "Custom list",
    railStorageKey: "custom-list",
  },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByLabelText("Open filters").querySelector(".lucide-sliders-horizontal"),
    ).toBeTruthy();
  },
};
