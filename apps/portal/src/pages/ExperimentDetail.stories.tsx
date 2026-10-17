// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, screen, userEvent } from "storybook/test";
import { HttpResponse, http } from "msw";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { ExperimentDetail } from "./ExperimentDetail";

const currentExecution = {
  experimentExecutionId: "execution-current",
  attemptNumber: 2,
  version: 1,
  readiness: "done",
  requests: [
    {
      requestId: "request-current",
      runId: "run-current",
      task: "Implement the current benchmark task",
      status: "done",
      outcome: "success",
      workerType: "coder-acp-copilot",
      model: "gpt-5.6-sol",
    },
  ],
  handlerProgress: {},
  blockers: [],
  createdAt: "2026-10-16T10:00:00.000Z",
};

const historicalExecution = {
  experimentExecutionId: "execution-history",
  attemptNumber: 1,
  version: 1,
  readiness: "failed",
  requests: [
    {
      requestId: "request-history",
      runId: "run-history",
      task: "Inspect the historical benchmark task",
      status: "done",
      outcome: "failure",
      workerType: "coder-acp-claude-code",
      model: "claude-opus-4.6",
    },
  ],
  handlerProgress: {},
  blockers: [],
  createdAt: "2026-10-15T10:00:00.000Z",
  supersededReason: "retry",
};

const experiment = {
  experimentId: "experiment-demo",
  projectId: "demo-project",
  metadata: {
    name: "Profile comparison",
    description: "Compare two agent profiles over the same benchmark task.",
  },
  revision: {
    experimentRevisionId: "revision-demo",
    revisionNumber: 1,
    memberCount: 1,
  },
  execution: currentExecution,
  readiness: "done",
  blocking: [],
  createdRequestIds: ["request-current"],
  createdAt: "2026-10-16T09:00:00.000Z",
};

function ExperimentDetailStory() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Routes>
          <Route
            path="/"
            element={<Navigate to="/experiments/experiment-demo" replace />}
          />
          <Route path="/experiments/:id" element={<ExperimentDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const meta = {
  component: ExperimentDetail,
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        http.get("/api/v1/experiments/experiment-demo", () =>
          HttpResponse.json(experiment),
        ),
        http.get(
          "/api/v1/experiments/experiment-demo/executions",
          () =>
            HttpResponse.json({
              data: [currentExecution, historicalExecution],
            }),
        ),
        http.get(
          "/api/v1/experiments/experiment-demo/executions/execution-history",
          () => HttpResponse.json(historicalExecution),
        ),
      ],
    },
  },
  render: () => <ExperimentDetailStory />,
} satisfies Meta<typeof ExperimentDetail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AttemptSelectionAndRunsTable: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect(
      await screen.findByText("Runs in attempt 2"),
    ).toBeVisible();
    await expect(
      screen.getAllByText("Implement the current benchmark task")[0],
    ).toBeVisible();
    const embeddedTable = canvasElement.querySelector(
      '[data-slot="embedded-table-block"]',
    );
    if (!embeddedTable) throw new Error("Embedded runs table block is missing");
    await expect(embeddedTable).toHaveClass("space-y-3");
    await expect(embeddedTable.parentElement).toHaveClass("p-6");

    await userEvent.click(
      canvas.getByRole("combobox", { name: "Experiment attempt" }),
    );
    await userEvent.click(
      await screen.findByRole("option", {
        name: "Attempt 1 · historical",
      }),
    );

    await expect(
      await screen.findByText(/Viewing processing attempt #1 \(historical\)/),
    ).toBeVisible();
    await expect(
      screen.getAllByText("Inspect the historical benchmark task")[0],
    ).toBeVisible();
    await expect(screen.queryAllByText("Implement the current benchmark task"))
      .toHaveLength(0);

    await userEvent.click(
      canvas.getByRole("button", { name: "Customize Columns" }),
    );
    await expect(
      canvas.getByRole("complementary", { name: "Customize columns" }),
    ).toBeVisible();
  },
};
