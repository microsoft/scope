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
  decorators: [
    (Story) => {
      setSelectedProjectIdHolder("demo-project");
      return <Story />;
    },
  ],
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        http.get("*/api/v1/agents", () => HttpResponse.json([])),
        http.get("*/api/v1/requests", () => HttpResponse.json({ data: [] })),
        http.get("*/api/v1/*", () => HttpResponse.json([])),
        http.post("*/api/v1/criteria/generate-prompt", () =>
          HttpResponse.json({
            prompt: "Record whether the codebase contains unit tests.",
            suggestedId: "has_unit_tests",
            suggestedParents: [],
            suggestedChildren: [],
            suggestedSubject: "run",
          }),
        ),
        http.post("*/api/v1/criteria", () =>
          HttpResponse.json({
            id: "has_unit_tests",
            prompt: "Record whether the codebase contains unit tests.",
            createdAt: "",
          }),
        ),
      ],
    },
  },
} satisfies Meta<typeof SubmitRun>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LegacyCompositionGuidance: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const link = await canvas.findByRole("link", { name: "New Experiment" });
    await expect(link).toHaveAttribute("href", "/experiments/new");
    await expect(
      canvas.getByText(/Creating multiple runs or profile variations/),
    ).toBeVisible();
    await expect(
      canvas.queryByText(/legacy-request-composition|Deprecated composition/),
    ).not.toBeInTheDocument();
  },
};

export const RunObservationCreation: Story = {
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(
      await canvas.findByRole("button", { name: "New Observation" }),
    );
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() =>
      expect(
        page.getByRole("heading", { name: "New Observation" }),
      ).toBeVisible(),
    );
    await expect(page.queryByLabelText("Criteria kind")).not.toBeInTheDocument();
    await expect(page.getByText(/Observation ID/)).toBeVisible();
    await expect(page.getByLabelText("Evaluation subject")).toHaveTextContent(
      "Whole run",
    );
    await expect(
      page.queryByText(/Gate criteria steer the agent/),
    ).not.toBeInTheDocument();
  },
};

export const ExperimentProgressiveDisclosure: Story = {
  args: {
    mode: "experiment",
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(
      canvas.getByRole("button", { name: /Create empty experiment/ }),
    ).toBeInTheDocument();
    const descriptionToggle = canvas.getByRole("button", {
      name: "Description (optional)",
    });
    await expect(descriptionToggle).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.queryByLabelText("Description")).not.toBeInTheDocument();
    await userEvent.click(descriptionToggle);
    await userEvent.type(
      canvas.getByLabelText("Description"),
      "Compare authentication approaches",
    );
    await userEvent.click(descriptionToggle);
    await userEvent.click(descriptionToggle);
    await expect(canvas.getByLabelText("Description")).toHaveValue(
      "Compare authentication approaches",
    );
    await expect(canvas.queryByLabelText("Tags")).not.toBeInTheDocument();
    await expect(canvas.queryByText("Gate pipeline")).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole("switch", { name: "Toggle advanced options" }),
    ).not.toBeInTheDocument();

    await userEvent.type(
      canvas.getByLabelText(/Task/),
      "Implement the benchmark task",
    );

    await expect(await canvas.findByText("Gate pipeline")).toBeInTheDocument();
    await expect(
      canvas.getByRole("switch", { name: "Toggle advanced options" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", {
        name: /Create experiment with 5 runs/,
      }),
    ).toBeInTheDocument();

    await userEvent.click(
      canvas.getByRole("button", { name: "New Observation" }),
    );
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() =>
      expect(
        page.getByRole("heading", { name: "New Observation" }),
      ).toBeVisible(),
    );
    await expect(page.queryByLabelText("Criteria kind")).not.toBeInTheDocument();
    await expect(page.getByText(/Observation ID/)).toBeVisible();
    await expect(page.getByLabelText("Evaluation subject")).toHaveTextContent(
      "Whole run",
    );
  },
};
