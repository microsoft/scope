// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  expect,
  fireEvent,
  screen,
  userEvent,
  waitFor,
} from "storybook/test";
import { HttpResponse, http } from "msw";
import { ExperimentsList } from "./ExperimentsList";

const experiment = (
  experimentId: string,
  name: string,
  readiness: string,
) => ({
  experimentId,
  projectId: "demo-project",
  metadata: {
    name,
    description: `${name} compares pinned agent configurations.`,
  },
  revision: {
    experimentRevisionId: `revision-${experimentId}`,
    revisionNumber: 1,
    memberCount: 4,
  },
  execution: {
    experimentExecutionId: `execution-${experimentId}`,
    attemptNumber: 2,
    version: 1,
    readiness,
    requests: [],
    handlerProgress: {},
    blockers: [],
    createdAt: "2026-10-16T10:00:00.000Z",
  },
  readiness,
  blocking: [],
  createdRequestIds: [],
  createdAt: "2026-10-16T09:00:00.000Z",
});

const meta = {
  component: ExperimentsList,
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        http.get("/api/v1/experiments", () =>
          HttpResponse.json({
            data: [
              experiment("experiment-alpha", "Alpha benchmark", "done"),
              experiment("experiment-beta", "Beta benchmark", "blocked"),
            ],
          }),
        ),
      ],
    },
  },
  decorators: [
    (Story) => (
      <div className="h-[760px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ExperimentsList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SharedListInteractions: Story = {
  play: async ({ canvas }) => {
    await expect(
      (await screen.findAllByText("Alpha benchmark"))[0],
    ).toBeVisible();
    await expect(
      canvas.getByRole("complementary", { name: "Filters" }),
    ).toBeVisible();
    const listShell = canvas
      .getByRole("heading", { name: "Experiments" })
      .closest("section")?.parentElement;
    if (!listShell) throw new Error("Experiments list shell is missing");
    await expect(listShell).toHaveClass("h-full");
    await expect(listShell).not.toHaveClass("px-6");

    fireEvent.change(canvas.getByPlaceholderText("Search experiments…"), {
      target: { value: "Beta" },
    });
    await waitFor(() => {
      expect(screen.queryAllByText("Alpha benchmark")).toHaveLength(0);
    });
    await expect(screen.getAllByText("Beta benchmark")[0]).toBeVisible();

    await userEvent.click(
      canvas.getByRole("button", { name: "Customize Columns" }),
    );
    await expect(
      canvas.getByRole("complementary", { name: "Customize columns" }),
    ).toBeVisible();
  },
};

export const DeletedVisibility: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/v1/experiments", ({ request }) => {
          const includeDeleted =
            new URL(request.url).searchParams.get("includeDeleted") === "true";
          return HttpResponse.json({
            data: includeDeleted
              ? [{
                  ...experiment(
                    "experiment-deleted",
                    "Deleted benchmark",
                    "done",
                  ),
                  deletedAt: "2026-10-16T12:00:00.000Z",
                  lifecycle: {
                    operationId: "operation-delete",
                    phase: "deleted",
                    stateVersion: 3,
                    progress: {
                      expectedRequests: 4,
                      completedRequests: 4,
                      expectedReports: 1,
                      completedReports: 1,
                    },
                    blocking: [],
                  },
                }]
              : [
                  experiment("experiment-alpha", "Alpha benchmark", "done"),
                ],
          });
        }),
      ],
    },
  },
  play: async ({ canvas }) => {
    await userEvent.click(
      canvas.getByRole("button", { name: "Show deleted" }),
    );
    await expect(
      (await screen.findAllByText("Deleted benchmark"))[0],
    ).toBeVisible();
    await expect(canvas.getByText("Hide deleted")).toBeVisible();
  },
};
