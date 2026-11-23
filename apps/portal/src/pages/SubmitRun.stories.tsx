// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, type within } from "storybook/test";
import { http, HttpResponse } from "msw";
import { SubmitRun } from "./SubmitRun";

const meta = {
  title: "Pages/SubmitRun",
  component: SubmitRun,
  tags: ["ai-generated", "needs-work"],
  parameters: {
    msw: {
      handlers: [
        http.get("/api/v1/version", () => HttpResponse.json({ commit: "demo", buildTime: "" })),
        http.get("/api/v1/agents", () => HttpResponse.json([])),
        http.get("/api/v1/mcp-servers", () => HttpResponse.json([])),
        http.get("/api/v1/profiles", () => HttpResponse.json([])),
        http.get("/api/v1/criteria", () => HttpResponse.json([])),
        http.get("/api/v1/requests", () => HttpResponse.json({ data: [], total: 0 })),
        http.get("/api/v1/task-prompts", () => HttpResponse.json({ items: [], total: 0 })),
      ],
    },
  },
} satisfies Meta<typeof SubmitRun>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Instances = {
  play: async ({ canvas }: { canvas: ReturnType<typeof within> }) => {
    const instances = canvas.getByRole("spinbutton", { name: "Instances" });
    await expect(instances).toHaveValue(5);
    await expect(canvas.queryByText("Occurrences")).not.toBeInTheDocument();
    await userEvent.clear(instances);
    await expect(instances).toHaveValue(1);
    await userEvent.type(instances, "0");
    await expect(instances).toHaveValue(10);
    await expect(canvas.getByRole("button", { name: /Submit 10 Runs/ })).toBeVisible();
  },
} satisfies Story;
