// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { http, HttpResponse } from "msw";
import { setSelectedProjectIdHolder } from "@/lib/project-scope";
import { CreateCriterionDialog } from "./CreateCriterionDialog";

const meta = {
  title: "Components/CreateCriterionDialog",
  component: CreateCriterionDialog,
  tags: ["ai-generated", "needs-work"],
  args: { open: true, onOpenChange: fn(), onCreated: fn() },
  decorators: [(Story) => {
    setSelectedProjectIdHolder("demo-project");
    return <Story />;
  }],
  render: (args) => {
    const [open, setOpen] = useState(args.open);
    return <CreateCriterionDialog {...args} open={open} onOpenChange={setOpen} />;
  },
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/v1/criteria", () => HttpResponse.json([])),
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
} satisfies Meta<typeof CreateCriterionDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GenericCriteria: Story = {
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(page.getByRole("heading", { name: "New Criteria" })).toBeVisible());
    await expect(page.getByLabelText("Criteria kind")).toBeVisible();
    await userEvent.type(page.getByLabelText(/What behavior do you want to track/), "Has unit tests");
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await expect(await page.findByText("Criteria Prompt (AI Generated)")).toBeVisible();
    await expect(page.getByText("Gate compatibility")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(args.onCreated).toHaveBeenCalledWith("has_unit_tests"));
  },
};

export const ObservationCreation: Story = {
  args: { mode: "observation" },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(page.getByRole("heading", { name: "New Observation" })).toBeVisible());
    await expect(page.queryByLabelText("Criteria kind")).not.toBeInTheDocument();
    await expect(page.getByLabelText("Evaluation subject")).toHaveTextContent("Whole run");
    await expect(page.getByText("Observation dimension")).toBeVisible();
    await userEvent.type(page.getByLabelText(/What behavior do you want to observe/), "Has unit tests");
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await expect(await page.findByText("Observation Prompt (AI Generated)")).toBeVisible();
    await expect(page.getAllByPlaceholderText("Search observations…")).toHaveLength(2);
    await expect(page.queryByText(/No gate-compatible criteria/)).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Create Observation" }));
    await waitFor(() => expect(args.onCreated).toHaveBeenCalledWith("has_unit_tests"));
  },
};

export const LegacyObservationDefault: Story = {
  args: { defaultKind: "observation" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(page.getByRole("heading", { name: "New Criteria" })).toBeVisible());
    await expect(page.getByLabelText("Criteria kind")).toHaveTextContent("Observation");
    await expect(page.getByLabelText("Evaluation subject")).toBeVisible();
  },
};
