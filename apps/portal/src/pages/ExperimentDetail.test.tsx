// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import type {
  ExperimentExecutionView,
  ExperimentView,
} from "@/lib/experiments";
import type { Report } from "@/types";

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    api: {
      ...original.api,
      getExperiment: vi.fn(),
      listExperimentExecutions: vi.fn(),
      getExperimentExecution: vi.fn(),
      listExperimentReports: vi.fn(),
      retryExperiment: vi.fn(),
      updateExperimentRequests: vi.fn(),
      deleteExperiment: vi.fn(),
      restoreExperiment: vi.fn(),
      experimentReportStructuredUrl: vi.fn(
        (_experimentId: string, executionId: string, reportId: string) =>
          `/api/v1/experiments/experiment-1/executions/${executionId}/reports/${reportId}/structured?projectId=project-1`,
      ),
    },
  };
});

import { ApiError, api } from "@/lib/api";
import { ExperimentDetail } from "./ExperimentDetail";

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

class IntersectionObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

const currentRequests = Array.from({ length: 11 }, (_, index) => ({
  requestId: `request-${String(index + 1).padStart(2, "0")}`,
  runId: `run-current-${String(index + 1).padStart(2, "0")}`,
  task: `Current task ${index + 1}`,
  status: index === 0 ? "done" : "pending",
  outcome: index === 0 ? "success" : undefined,
  workerType: "coder-acp-copilot",
  model: "gpt-5.6-sol",
}));

const currentExecution: ExperimentExecutionView = {
  experimentExecutionId: "execution-current",
  attemptNumber: 2,
  readiness: "done",
  requestCount: currentRequests.length,
  requests: currentRequests,
  handlerProgress: {},
  blocking: [],
  createdAt: "2026-10-16T10:00:00.000Z",
};

const historicalExecution: ExperimentExecutionView = {
  experimentExecutionId: "execution-history",
  attemptNumber: 1,
  readiness: "failed",
  requestCount: 1,
  requests: [
    {
      requestId: "request-history",
      runId: "run-history",
      task: "Historical task",
      status: "done",
      outcome: "failure",
      workerType: "coder-acp-claude-code",
      model: "claude-opus-4.6",
    },
  ],
  handlerProgress: {},
  blocking: [],
  createdAt: "2026-10-15T10:00:00.000Z",
  supersededReason: "retry",
};

const experiment: ExperimentView = {
  experimentId: "experiment-1",
  projectId: "project-1",
  metadata: { name: "Profile comparison" },
  revision: {
    experimentRevisionId: "revision-1",
    revisionNumber: 1,
    memberCount: 11,
  },
  execution: currentExecution,
  readiness: "done",
  blocking: [],
  createdRequestIds: currentRequests.map((request) => request.requestId),
  createdAt: "2026-10-16T09:00:00.000Z",
};

const historicalReport: Report = {
  _id: "report-1",
  id: "report-1",
  experimentId: "experiment-1",
  experimentExecutionId: "execution-history",
  status: "completed",
  content: "# Historical readout\n\nExact attempt evidence.",
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
    url: "reports/report-1/structured.json",
  },
  createdAt: "2026-10-16T10:30:00.000Z",
};

const currentReport: Report = {
  ...historicalReport,
  _id: "report-current",
  id: "report-current",
  experimentExecutionId: "execution-current",
  content: "# Current readout\n\nLatest exact-attempt evidence.",
  createdAt: "2026-10-16T11:30:00.000Z",
};

const previousCurrentReport: Report = {
  ...currentReport,
  _id: "report-previous",
  id: "report-previous",
  content: "# Previous readout\n\nEarlier retry output.",
  createdAt: "2026-10-16T11:00:00.000Z",
};

const qualityReport: Report = {
  ...currentReport,
  _id: "report-quality",
  id: "report-quality",
  templateId: "quality-summary",
  content: "# Quality summary\n\nAn additional report type.",
  reporter: {
    ...currentReport.reporter!,
    id: "quality-summary",
    name: "Quality Summary",
  },
  createdAt: "2026-10-16T11:15:00.000Z",
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

function renderDetail(
  initialEntry = "/experiments/experiment-1",
  experimentValue = experiment,
) {
  vi.mocked(api.getExperiment).mockResolvedValue(experimentValue);
  vi.mocked(api.listExperimentExecutions).mockResolvedValue({
    items: [currentExecution, historicalExecution],
  });
  vi.mocked(api.getExperimentExecution).mockImplementation(
    async (_experimentId, executionId) => {
      if (executionId === historicalExecution.experimentExecutionId) {
        return historicalExecution;
      }
      return currentExecution;
    },
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/experiments/:id"
            element={
              <>
                <ExperimentDetail />
                <LocationProbe />
              </>
            }
          />
          <Route path="/runs/:id" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverMock,
  });
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: IntersectionObserverMock,
  });
});

beforeEach(() => {
  vi.mocked(api.listExperimentReports).mockReset();
  vi.mocked(api.listExperimentReports).mockResolvedValue([]);
  vi.mocked(api.deleteExperiment).mockReset();
  vi.mocked(api.restoreExperiment).mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("ExperimentDetail", { timeout: 10_000 }, () => {
  it("starts an asynchronous deletion from the confirmation dialog", async () => {
    vi.mocked(api.deleteExperiment).mockResolvedValue({
      operationId: "operation-delete",
      phase: "deleting",
      stateVersion: 2,
      progress: {
        expectedRequests: 11,
        completedRequests: 0,
        expectedReports: 2,
        completedReports: 0,
      },
      blocking: [],
    });
    renderDetail();

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(
      screen.getByRole("heading", { name: "Delete this Experiment?" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Delete Experiment/ }),
    );

    await waitFor(() => {
      expect(api.deleteExperiment).toHaveBeenCalledWith("experiment-1");
    });
  });

  it("shows deleted lifecycle progress and restores the Experiment", async () => {
    const user = userEvent.setup();
    const deletedExperiment: ExperimentView = {
      ...experiment,
      deletedAt: "2026-10-16T12:00:00.000Z",
      lifecycle: {
        operationId: "operation-delete",
        phase: "deleted",
        stateVersion: 3,
        progress: {
          expectedRequests: 11,
          completedRequests: 11,
          expectedReports: 2,
          completedReports: 2,
        },
        blocking: [],
      },
    };
    vi.mocked(api.restoreExperiment).mockResolvedValue({
      ...deletedExperiment.lifecycle!,
      operationId: "operation-restore",
      phase: "restoring",
      stateVersion: 4,
    });
    renderDetail("/experiments/experiment-1?includeDeleted=true", deletedExperiment);

    expect(
      await screen.findByRole("heading", {
        name: "Lifecycle operation · deleted",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Requests 11/11 · Reports 2/2")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => {
      expect(api.restoreExperiment).toHaveBeenCalledWith("experiment-1");
    });
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("defaults to the current attempt and paginates its shared runs table", async () => {
    renderDetail();

    expect(await screen.findByText("Runs in attempt 2")).toBeTruthy();
    expect(screen.getAllByText("Current task 1").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Historical task")).toHaveLength(0);
    expect(screen.getByText("1–10 of 11 runs")).toBeTruthy();
    const embeddedTable = document.querySelector(
      '[data-slot="embedded-table-block"]',
    );
    if (!embeddedTable) throw new Error("Embedded runs table block is missing");
    expect(embeddedTable.className).toContain("space-y-3");
    expect(embeddedTable.parentElement?.className).toContain("p-6");
    const header = document.querySelector(
      '[data-slot="experiment-detail-header"]',
    );
    const tabList = screen.getByRole("tablist", {
      name: "Experiment detail sections",
    });
    expect(header?.nextElementSibling).toBe(tabList.parentElement);
    expect(screen.queryByText("Execution attempt 2")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect((await screen.findAllByText("Current task 11")).length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Current task 1")).toHaveLength(0);

    fireEvent.click(
      screen.getByRole("button", { name: "Customize Columns" }),
    );
    expect(screen.getByRole("complementary", {
      name: "Customize columns",
    })).toBeTruthy();
  });

  it("deep-links one historical attempt and preserves exact run navigation", async () => {
    renderDetail(
      "/experiments/experiment-1?executionId=execution-history",
    );

    expect(
      await screen.findByText("Historical attempt"),
    ).toBeTruthy();
    expect(screen.getByText("Runs in attempt 1")).toBeTruthy();
    expect(screen.getAllByText("Historical task").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Current task 1")).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: "Retry processing" }),
    ).toBeNull();
    fireEvent.click(screen.getAllByText("Historical task")[0]);
    expect((await screen.findByTestId("location")).textContent).toBe(
      "/runs/request-history?runId=run-history",
    );

  });

  it("keeps processing retry disabled for a historical attempt", async () => {
    renderDetail(
      "/experiments/experiment-1?executionId=execution-history&tab=processing",
    );

    expect(
      (
        await screen.findByRole("button", { name: "Retry processing" })
      ).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("returns from a historical attempt to the current attempt", async () => {
    const user = userEvent.setup();
    renderDetail(
      "/experiments/experiment-1?executionId=execution-history",
    );

    await user.click(
      await screen.findByRole("combobox", { name: "Experiment attempt" }),
    );
    await user.click(
      screen.getByRole("option", { name: "Attempt 2 · current" }),
    );

    await waitFor(() => {
      expect(screen.getByText("Runs in attempt 2")).toBeTruthy();
    });
    expect(screen.getAllByText("Current task 1").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Historical task")).toHaveLength(0);
  });

  it("loads the report and structured artifact for the exact selected attempt", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listExperimentReports).mockImplementation(
      async (_experimentId, executionId) =>
        executionId === historicalExecution.experimentExecutionId
          ? [historicalReport]
          : [],
    );

    renderDetail(
      "/experiments/experiment-1?executionId=execution-history",
    );

    expect(
      await screen.findByRole("heading", { name: "Historical readout" }),
    ).toBeTruthy();
    expect(api.listExperimentReports).toHaveBeenCalledWith(
      "experiment-1",
      "execution-history",
      { includeDeleted: false },
    );
    expect(
      screen.getByRole("link", { name: "Structured JSON" }).getAttribute("href"),
    ).toContain("/executions/execution-history/reports/report-1/structured");

    await user.click(
      screen.getByRole("combobox", { name: "Experiment attempt" }),
    );
    await user.click(
      screen.getByRole("option", { name: "Attempt 2 · current" }),
    );
    await waitFor(() => {
      expect(api.listExperimentReports).toHaveBeenCalledWith(
        "experiment-1",
        "execution-current",
        { includeDeleted: false },
      );
    });
  });

  it("retries report loading for the same exact attempt", async () => {
    vi.mocked(api.listExperimentReports)
      .mockRejectedValueOnce(new Error("Report service unavailable"))
      .mockResolvedValueOnce([]);

    renderDetail();

    expect(await screen.findByText("Report service unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Retry$/ }));
    await waitFor(() => {
      expect(api.listExperimentReports).toHaveBeenCalledTimes(2);
    });
    expect(api.listExperimentReports).toHaveBeenLastCalledWith(
      "experiment-1",
      "execution-current",
      { includeDeleted: false },
    );
    expect(
      await screen.findByText("Runs in attempt 2"),
    ).toBeTruthy();
  });

  it("defaults to Reports for one report without showing unnecessary selectors", async () => {
    vi.mocked(api.listExperimentReports).mockResolvedValue([currentReport]);

    renderDetail();

    expect(
      await screen.findByRole("heading", { name: "Current readout" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Reports" }).getAttribute(
        "data-state",
      ),
    ).toBe("active");
    expect(screen.queryByRole("combobox", { name: "Report type" })).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Report version" }),
    ).toBeNull();
  });

  it("defaults to the latest retry version and selects historical versions", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listExperimentReports).mockResolvedValue([
      previousCurrentReport,
      currentReport,
    ]);

    renderDetail();

    expect(
      await screen.findByRole("heading", { name: "Current readout" }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("combobox", { name: "Report version" }),
    );
    await user.click(
      screen.getByRole("option", { name: /Version 1 · Historical/ }),
    );

    expect(
      await screen.findByRole("heading", { name: "Previous readout" }),
    ).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toContain(
      "reportType=reporter%3App-readout",
    );
    expect(screen.getByTestId("location").textContent).toContain(
      "reportId=report-previous",
    );
    expect(
      screen.getByRole("link", { name: "Direct link" }).getAttribute("href"),
    ).toContain("/reports/report-previous?");
  });

  it("selects one report type at a time and honors direct query selection", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listExperimentReports).mockResolvedValue([
      previousCurrentReport,
      currentReport,
      qualityReport,
    ]);

    renderDetail(
      "/experiments/experiment-1?tab=reports&reportType=reporter%3App-readout&reportId=report-previous",
    );

    expect(
      await screen.findByRole("heading", { name: "Previous readout" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("combobox", { name: "Report type" }));
    await user.click(
      screen.getByRole("option", { name: /Quality Summary/ }),
    );

    expect(
      await screen.findByRole("heading", { name: "Quality summary" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Current readout" })).toBeNull();
    expect(screen.getByTestId("location").textContent).toContain(
      "reportType=template%3Aquality-summary",
    );
    expect(screen.getByTestId("location").textContent).toContain(
      "reportId=report-quality",
    );
  });

  it("falls back safely from stale tab, report type, and report version links", async () => {
    vi.mocked(api.listExperimentReports).mockResolvedValue([
      currentReport,
      qualityReport,
    ]);

    renderDetail(
      "/experiments/experiment-1?tab=missing&reportType=missing&reportId=missing",
    );

    expect(
      await screen.findByRole("heading", { name: "Current readout" }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        "/experiments/experiment-1",
      );
    });
  });

  it("falls back safely from a stale attempt while preserving a valid tab", async () => {
    vi.mocked(api.getExperimentExecution).mockRejectedValueOnce(
      new ApiError("Experiment execution not found", 404),
    );

    renderDetail(
      "/experiments/experiment-1?executionId=execution-missing&tab=runs&reportId=report-missing",
    );

    expect(await screen.findByText("Runs in attempt 2")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        "/experiments/experiment-1?tab=runs",
      );
    });
  });

  it("defaults to Processing while blocked and keeps retry recovery scoped there", async () => {
    vi.mocked(api.retryExperiment).mockResolvedValue({
      experimentId: "experiment-1",
      experimentExecutionId: "execution-retry",
      attemptNumber: 3,
    });
    const processingExperiment: ExperimentView = {
      ...experiment,
      readiness: "blocked",
      execution: {
        ...currentExecution,
        readiness: "blocked",
        handlerProgress: {
          "pp-observations": { status: "done" },
          "pp-readout": {
            status: "failed",
            error: "A dependency must be retried.",
          },
        },
      },
    };

    renderDetail("/experiments/experiment-1", processingExperiment);

    expect(
      (
        await screen.findByRole("tab", { name: "Processing" })
      ).getAttribute("data-state"),
    ).toBe("active");
    expect(screen.getByText("pp-observations")).toBeTruthy();
    expect(screen.getByText("pp-readout")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry processing" }));
    await waitFor(() => {
      expect(api.retryExperiment).toHaveBeenCalledWith(
        "experiment-1",
        "execution-current",
      );
    });
  });

  it("preserves the selected tab across attempts and clears report history state", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listExperimentReports).mockImplementation(
      async (_experimentId, executionId) =>
        executionId === "execution-current"
          ? [previousCurrentReport, currentReport]
          : [historicalReport],
    );

    renderDetail(
      "/experiments/experiment-1?tab=reports&reportType=reporter%3App-readout&reportId=report-previous",
    );

    expect(
      await screen.findByRole("heading", { name: "Previous readout" }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("combobox", { name: "Experiment attempt" }),
    );
    await user.click(
      screen.getByRole("option", { name: "Attempt 1 · historical" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Historical readout" }),
    ).toBeTruthy();
    const location = screen.getByTestId("location").textContent ?? "";
    expect(location).toContain("executionId=execution-history");
    expect(location).toContain("tab=reports");
    expect(location).not.toContain("report-previous");
  });

  it("removes selected current members in one revision-guarded request", async () => {
    const nextExperiment: ExperimentView = {
      ...experiment,
      revision: {
        experimentRevisionId: "revision-2",
        revisionNumber: 2,
        memberCount: 10,
      },
      execution: {
        ...currentExecution,
        experimentExecutionId: "execution-3",
        requestCount: 10,
        requests: currentRequests.filter(
          (request) => request.requestId !== "request-02",
        ),
      },
    };
    vi.mocked(api.updateExperimentRequests).mockResolvedValue({
      experiment: nextExperiment,
      attachedRequestIds: [],
      detachedRequestIds: ["request-02"],
    });

    renderDetail("/experiments/experiment-1?tab=runs");

    const rowCheckboxes = await screen.findAllByRole("checkbox", {
      name: "Select row",
    });
    fireEvent.click(rowCheckboxes[1]);
    fireEvent.click(screen.getByRole("button", { name: "Remove (1)" }));
    fireEvent.click(screen.getByRole("button", { name: /Remove runs/ }));

    await waitFor(() => {
      expect(api.updateExperimentRequests).toHaveBeenCalledTimes(1);
    });
    expect(api.updateExperimentRequests).toHaveBeenCalledWith(
      "DELETE",
      "experiment-1",
      {
        expectedExperimentRevisionId: "revision-1",
        requestIds: ["request-02"],
      },
    );
    expect(await screen.findByText(/Revision 2 · 10 current members/)).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toContain("tab=runs");
  });
});
