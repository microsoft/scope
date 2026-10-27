// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent } from "storybook/test";
import { NumericComparatorRow } from "./RunsList";

function EmptyIterationFilter() {
  const [op, setOp] = useState<"eq" | "gte" | "lte">("gte");
  const [value, setValue] = useState("");

  return (
    <div className="w-72 space-y-2">
      <NumericComparatorRow
        label="Turns"
        ariaLabel="Filter runs by number of turns"
        op={op}
        value={value}
        onChange={(next) => {
          setOp(next.op);
          setValue(next.value);
        }}
      />
      <output data-testid="iteration-filter">{`${op}:${value || "any"}`}</output>
    </div>
  );
}

const meta = {
  title: "Pages/Runs/Iteration filter",
  component: NumericComparatorRow,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof NumericComparatorRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ChooseComparisonBeforeValue: Story = {
  args: {
    label: "Turns",
    ariaLabel: "Filter runs by number of turns",
    op: "gte",
    value: "",
    onChange: () => {},
  },
  render: () => <EmptyIterationFilter />,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("combobox", { name: "Filter runs by number of turns comparator" }));
    await userEvent.click(await screen.findByRole("option", { name: "≤" }));
    await expect(canvas.getByTestId("iteration-filter")).toHaveTextContent("lte:any");

    await userEvent.type(canvas.getByRole("spinbutton", { name: "Filter runs by number of turns" }), "3");
    await expect(canvas.getByTestId("iteration-filter")).toHaveTextContent("lte:3");
  },
};
