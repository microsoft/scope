// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { http, HttpResponse } from "msw";
import type { SkillDocument } from "@/types";
import { getSelectedProjectId, setSelectedProjectIdHolder } from "@/lib/project-scope";
import { SkillPicker } from "./SkillPicker";

const skills = Array.from({ length: 13 }, (_, index) => ({
  _id: `azure/cosmos-kit/cosmos-${String(index + 1).padStart(2, "0")}`,
  name: `Cosmos DB skill ${index + 1}`,
  description: "Azure Cosmos DB agent guidance",
})) as SkillDocument[];

function SkillPickerHarness() {
  const [selected, setSelected] = useState<string[]>([]);
  const [scopeReady, setScopeReady] = useState(false);

  useEffect(() => {
    const previousProjectId = getSelectedProjectId();
    setSelectedProjectIdHolder("demo-project");
    setScopeReady(true);
    return () => setSelectedProjectIdHolder(previousProjectId);
  }, []);

  if (!scopeReady) return null;

  return (
    <div className="w-[44rem] max-w-full p-6">
      <SkillPicker selected={selected} onChange={setSelected} />
    </div>
  );
}

const meta = {
  component: SkillPicker,
  render: () => <SkillPickerHarness />,
  args: {
    selected: [],
    onChange: () => {},
  },
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/v1/skills", () => HttpResponse.json(skills)),
        http.get("*/api/v1/skills/search/external", () => HttpResponse.json([])),
        http.get("*/api/v1/skills/*/revisions", () => HttpResponse.json([])),
      ],
    },
  },
} satisfies Meta<typeof SkillPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MultiSelectSearch: Story = {
  play: async ({ canvas, canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const input = await canvas.findByPlaceholderText("Search for skills…");
    await userEvent.type(input, "cosmos");
    await userEvent.click(await page.findByRole("button", { name: /cosmos-01/i }));

    await expect(input).toHaveValue("cosmos");
    await expect(page.getByRole("button", { name: /cosmos-02/i })).toBeVisible();
  },
};
