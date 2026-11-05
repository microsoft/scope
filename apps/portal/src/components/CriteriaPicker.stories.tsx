// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { http, HttpResponse } from "msw";
import { setSelectedProjectIdHolder } from "@/lib/project-scope";
import { CriteriaPicker } from "./CriteriaPicker";

const meta = {
  title: "Components/CriteriaPicker",
  component: CriteriaPicker,
  tags: ["ai-generated", "needs-work"],
  args: { selected: [], onChange: () => undefined },
  decorators: [(Story) => {
    setSelectedProjectIdHolder("demo-project");
    return <div className="max-w-xl p-6"><Story /></div>;
  }],
  render: (args) => {
    const [selected, setSelected] = useState<string[]>([]);
    return <CriteriaPicker {...args} selected={selected} onChange={setSelected} />;
  },
  parameters: {
    msw: {
      handlers: [http.get("*/api/v1/criteria", () => HttpResponse.json([
        { id: "gate_requirement", prompt: "The project builds.", kind: "gate", createdAt: "" },
        { id: "has_tests", prompt: "Record whether tests exist.", kind: "observation", createdAt: "" },
      ]))],
    },
  },
} satisfies Meta<typeof CriteriaPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GenericCriteria: Story = {
  play: async ({ canvas, canvasElement }) => {
    const input = await canvas.findByPlaceholderText("Type to search criteria…");
    await userEvent.type(input, "missing");
    await expect(await within(canvasElement.ownerDocument.body).findByText("No matching criteria")).toBeVisible();
  },
};

export const ObservationDependencies: Story = {
  args: { kind: "observation", entityLabel: "observations" },
  play: async ({ canvas, canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const input = await canvas.findByPlaceholderText("Search observations…");
    await userEvent.click(input);
    await expect(page.queryByRole("button", { name: /gate_requirement/ })).not.toBeInTheDocument();
    await userEvent.click(await page.findByRole("button", { name: /has_tests/ }));
    await expect(canvas.getByText("has_tests")).toBeVisible();
    await userEvent.type(input, "missing");
    await expect(await page.findByText("No matching observations")).toBeVisible();
  },
};
