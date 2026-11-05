// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { http, HttpResponse } from "msw";
import { setSelectedProjectIdHolder } from "@/lib/project-scope";
import { SubmitRun } from "./SubmitRun";

const meta = {
  title: "Pages/Submit Run",
  component: SubmitRun,
  tags: ["ai-generated", "needs-work"],
  decorators: [(Story) => {
    setSelectedProjectIdHolder("demo-project");
    return <Story />;
  }],
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        http.get("*/api/v1/agents", () => HttpResponse.json([])),
        http.get("*/api/v1/requests", () => HttpResponse.json({ data: [] })),
        http.get("*/api/v1/*", () => HttpResponse.json([])),
        http.post("*/api/v1/criteria/generate-prompt", () => HttpResponse.json({
          prompt: "Record whether the codebase contains unit tests.",
          suggestedId: "has_unit_tests",
          suggestedParents: [],
          suggestedChildren: [],
          suggestedSubject: "run",
        })),
        http.post("*/api/v1/criteria", () => HttpResponse.json({
          id: "has_unit_tests", prompt: "Record whether the codebase contains unit tests.", createdAt: "",
        })),
      ],
    },
  },
} satisfies Meta<typeof SubmitRun>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RunObservationCreation: Story = {
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "New Observation" }));
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(page.getByRole("heading", { name: "New Observation" })).toBeVisible());
    await expect(page.queryByLabelText("Criteria kind")).not.toBeInTheDocument();
    await expect(page.getByText(/Observation ID/)).toBeVisible();
    await expect(page.getByLabelText("Evaluation subject")).toHaveTextContent("Whole run");
    await expect(page.queryByText(/Gate criteria steer the agent/)).not.toBeInTheDocument();
  },
};
