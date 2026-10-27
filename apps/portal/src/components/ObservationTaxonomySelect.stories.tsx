// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ObservationTaxonomySelect } from "./ObservationTaxonomySelect";
import type { TaxonomyElementId } from "@/types";

const meta = {
  title: "Components/ObservationTaxonomySelect",
  component: ObservationTaxonomySelect,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof ObservationTaxonomySelect>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    value: "dimension:idiomatic-use",
    onChange: () => undefined,
  },
  render: () => {
    const [value, setValue] = useState<TaxonomyElementId | undefined>("dimension:idiomatic-use");
    return (
      <div className="max-w-sm">
        <ObservationTaxonomySelect value={value} onChange={setValue} />
      </div>
    );
  },
};
