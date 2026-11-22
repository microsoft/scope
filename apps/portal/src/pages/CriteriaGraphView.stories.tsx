// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect } from "storybook/test";

import { CriteriaGraphView } from "./CriteriaGraphView";

const graph = {
  nodes: [
    { id: "root", prompt: "The project builds", dependsOn: [] },
    { id: "child", prompt: "Tests pass", dependsOn: ["root"] },
    { id: "standalone", prompt: "The README is clear", dependsOn: [] },
  ],
  edges: [{ source: "root", target: "child" }],
};

const meta = {
  component: CriteriaGraphView,
  parameters: {
    msw: { handlers: [http.get("*/api/v1/criteria/graph", () => HttpResponse.json(graph))] },
  },
} satisfies Meta<typeof CriteriaGraphView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithIndependentCriterion: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("Independent criteria (1)")).toBeVisible();
    await expect(canvas.getByRole("link", { name: /standalone/ })).toHaveAttribute("href", "/criteria/standalone");
  },
};
