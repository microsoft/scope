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
      criteria: ["uses_typescript"],
      taskPromptId: "task-prompt-current",
      status: "processing",
      workerType: "coder-acp-copilot",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      agentVersion: "copilot-dev",
      os: { platform: "linux", release: "6.8", arch: "arm64" },
      mcpServers: ["github"],
      skillRevisions: ["owner/skills/typescript@r1"],
      extensions: ["ms-vscode.vscode-typescript-next@1.0.0"],
      priority: 5,
      attemptNumber: 2,
      worker: { instanceId: "worker-current", podName: "pod-current" },
      startedAt: "2026-10-16T09:59:30.000Z",
    },
    {
      requestId: "request-queued",
      runId: "run-queued",
      task: "Implement the queued benchmark task",
      status: "queued",
      workerType: "coder-acp-copilot",
      model: "gpt-5.6-sol",
    },
    {
      requestId: "request-deleted",
      runId: "run-deleted",
      task: "Deleted exact member",
      status: "deleted",
    },
    {
      requestId: "request-missing",
      runId: "run-missing",
      task: "Missing exact member",
      status: "missing",
    },
  ],
  handlerProgress: {
    "pp-readout": { status: "done" },
  },
  reportTemplates: {
    "quality-summary": {
      templateId: "quality-summary",
      source: "selected",
      status: "done",
      matchingRunCount: 0,
    },
    "risk-summary": {
      templateId: "risk-summary",
      source: "linked",
      status: "waiting",
      matchingRunCount: 1,
    },
  },
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
  reportTemplates: {},
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
    memberCount: 4,
    reportTemplateIds: ["quality-summary"],
  },
  execution: currentExecution,
  readiness: "done",
  blocking: [],
  createdRequestIds: ["request-current"],
  createdAt: "2026-10-16T09:00:00.000Z",
};

const deletedExperiment = {
  ...experiment,
  deletedAt: "2026-10-16T12:00:00.000Z",
  lifecycle: {
    operationId: "operation-delete",
    phase: "deleted",
    stateVersion: 3,
    progress: {
      expectedRequests: 1,
      completedRequests: 1,
      expectedReports: 3,
      completedReports: 3,
    },
    blocking: [],
    deleteRequestedAt: "2026-10-16T11:55:00.000Z",
    deleteCompletedAt: "2026-10-16T12:00:00.000Z",
  },
};

const currentReports = [
  {
    _id: "report-current",
    id: "report-current",
    experimentId: "experiment-demo",
    experimentExecutionId: "execution-current",
    status: "completed",
    content: "# Current readout\n\nThe latest exact-vector analysis.",
    reporter: {
      id: "pp-readout",
      name: "Experiment Readout",
      gitHash: "abc",
      model: "gpt-5.4",
      agentId: "copilot-sdk",
      agentVersion: "1.0.0",
    },
    structuredArtifact: {
      schemaId: "scope.experiment-readout",
      schemaVersion: "1.0",
      contentType: "application/json",
      url: "reports/report-current/structured.json",
    },
    createdAt: "2026-10-16T10:30:00.000Z",
  },
  {
    _id: "report-previous",
    id: "report-previous",
    experimentId: "experiment-demo",
    experimentExecutionId: "execution-current",
    status: "completed",
    content: "# Previous readout\n\nThe first report version.",
    reporter: {
      id: "pp-readout",
      name: "Experiment Readout",
      gitHash: "abc",
      model: "gpt-5.4",
      agentId: "copilot-sdk",
      agentVersion: "1.0.0",
    },
    createdAt: "2026-10-16T10:15:00.000Z",
  },
  {
    _id: "report-quality",
    id: "report-quality",
    experimentId: "experiment-demo",
    experimentExecutionId: "execution-current",
    templateId: "quality-summary",
    status: "completed",
    content: "# Quality summary\n\nAn additional attached report.",
    reporter: {
      id: "quality-summary",
      name: "Quality Summary",
      gitHash: "def",
      model: "gpt-5.4",
      agentId: "copilot-sdk",
      agentVersion: "1.0.0",
    },
    createdAt: "2026-10-16T10:20:00.000Z",
  },
];

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
        http.get(
          "/api/v1/experiments/experiment-demo/executions/:executionId/reports",
          ({ params }) =>
            HttpResponse.json(
              params.executionId === "execution-current"
                ? currentReports
                : [],
            ),
        ),
        http.get("/api/v1/report-templates", () =>
          HttpResponse.json([
            {
              _id: "quality-summary",
              id: "quality-summary",
              projectId: "demo-project",
              subject: "experiment",
              name: "Quality summary",
              userPrompt: "Summarize quality.",
              enabled: true,
              currentVersionId: "quality-summary:v2",
              currentVersion: 2,
              contentFingerprint: "quality-v2",
              createdAt: "2026-10-16T08:00:00.000Z",
            },
            {
              _id: "risk-summary",
              id: "risk-summary",
              projectId: "demo-project",
              subject: "experiment",
              name: "Risk summary",
              userPrompt: "Summarize risks.",
              trigger: {
                type: "run-report-templates",
                reportTemplateIds: ["security"],
              },
              enabled: true,
              currentVersionId: "risk-summary:v1",
              currentVersion: 1,
              contentFingerprint: "risk-v1",
              createdAt: "2026-10-16T08:00:00.000Z",
            },
          ]),
        ),
        http.get("/api/v1/requests/request-current", () =>
          HttpResponse.json({
            _id: "request-current",
            id: "request-current",
            scenario: {
              task: "Implement the current benchmark task",
              criteria: ["uses_typescript"],
            },
            workerType: "coder-acp-copilot",
            model: "gpt-5.6-sol",
            agentVersion: "copilot-dev",
            createdAt: "2026-10-16T09:00:00.000Z",
            run: {
              _id: "run-current",
              attemptNumber: 2,
              status: "processing",
              startedAt: "2026-10-16T09:59:30.000Z",
            },
          }),
        ),
        http.get("/api/v1/requests/request-current/runs", () =>
          HttpResponse.json([]),
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
      await screen.findByRole("heading", { name: "Current readout" }),
    ).toBeVisible();
    const tabList = canvas.getByRole("tablist", {
      name: "Experiment detail sections",
    });
    const header = canvasElement.querySelector(
      '[data-slot="experiment-detail-header"]',
    );
    if (!header) throw new Error("Compact Experiment header is missing");
    await expect(header.nextElementSibling).toBe(tabList.parentElement);

    await userEvent.click(canvas.getByRole("tab", { name: "Runs" }));
    await expect(
      await screen.findByText("Runs in attempt 2"),
    ).toBeVisible();
    await expect(
      screen.getAllByText("Implement the current benchmark task")[0],
    ).toBeVisible();
    const processingBadge = screen
      .getAllByText("Processing")
      .find((element) => element.className.includes("animate-shimmer"));
    if (!processingBadge) throw new Error("Processing status is not animated");
    await expect(processingBadge).toBeVisible();
    await expect(screen.getAllByText("Deleted")[0]).toBeVisible();
    await expect(screen.getAllByText("Missing")[0]).toBeVisible();
    const embeddedTable = canvasElement.querySelector(
      '[data-slot="embedded-table-block"]',
    );
    if (!embeddedTable) throw new Error("Embedded runs table block is missing");
    await expect(embeddedTable).toHaveClass("space-y-3");
    await expect(embeddedTable.parentElement).toHaveClass("p-6");
    const currentTask = screen.getAllByText(
      "Implement the current benchmark task",
    )[0];
    const currentRow = currentTask.closest("tr");
    if (!currentRow) throw new Error("Current run row is missing");
    await userEvent.click(currentRow);
    await expect(
      await screen.findByRole("complementary", { name: "Detail panel" }),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Close detail panel" }),
    );

    await userEvent.click(
      canvas.getByRole("combobox", { name: "Experiment attempt" }),
    );
    await userEvent.click(
      await screen.findByRole("option", {
        name: "Attempt 1 · historical",
      }),
    );

    await expect(
      await screen.findByText("Historical attempt"),
    ).toBeVisible();
    await expect(
      (await screen.findAllByText("Inspect the historical benchmark task"))[0],
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

export const DeletedLifecycleAndRestore: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/v1/experiments/experiment-demo", () =>
          HttpResponse.json(deletedExperiment),
        ),
        http.post("/api/v1/experiments/experiment-demo/restore", () =>
          HttpResponse.json({
            ...deletedExperiment.lifecycle,
            operationId: "operation-restore",
            phase: "restoring",
            stateVersion: 4,
            restoreRequestedAt: "2026-10-16T12:05:00.000Z",
          }, { status: 202 }),
        ),
      ],
    },
  },
  play: async ({ canvas }) => {
    await expect(
      await screen.findByRole("heading", {
        name: "Lifecycle operation · deleted",
      }),
    ).toBeVisible();
    await expect(
      canvas.getByText("Requests 1/1 · Reports 3/3"),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Restore" }));
  },
};

export const ReportTemplateConfiguration: Story = {
  play: async ({ canvas }) => {
    await expect(
      await screen.findByRole("heading", { name: "Current readout" }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Processing" }));
    await expect(
      await screen.findByText("Selectable manual reports"),
    ).toBeVisible();
    await expect(screen.getByText("Automatic always")).toBeVisible();
    await expect(screen.getByText("Automatic linked-run")).toBeVisible();
    await expect(
      screen.getByRole("checkbox", { name: /Quality summary/ }),
    ).toBeChecked();
    await expect(screen.getByText("1 matching run")).toBeVisible();
    await expect(
      screen.getByRole("button", { name: "Publish report configuration" }),
    ).toBeVisible();

  },
};
