// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    api: {
      ...original.api,
      getExperiment: vi.fn(),
      listExperimentExecutions: vi.fn(),
      getExperimentExecution: vi.fn(),
      retryExperiment: vi.fn(),
    },
  };
});

import { api } from "@/lib/api";
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

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

function renderDetail(initialEntry = "/experiments/experiment-1") {
  vi.mocked(api.getExperiment).mockResolvedValue(experiment);
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
          <Route path="/experiments/:id" element={<ExperimentDetail />} />
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

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("ExperimentDetail", () => {
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
      await screen.findByText(/Viewing processing attempt #1 \(historical\)/),
    ).toBeTruthy();
    expect(screen.getByText("Runs in attempt 1")).toBeTruthy();
    expect(screen.getAllByText("Historical task").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Current task 1")).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Retry processing" }).hasAttribute(
        "disabled",
      ),
    ).toBe(true);

    fireEvent.click(screen.getAllByText("Historical task")[0]);
    expect((await screen.findByTestId("location")).textContent).toBe(
      "/runs/request-history?runId=run-history",
    );
  });

  it("returns from a historical attempt to the current attempt", async () => {
    renderDetail(
      "/experiments/experiment-1?executionId=execution-history",
    );

    fireEvent.click(await screen.findByRole("button", {
      name: "View current attempt",
    }));

    await waitFor(() => {
      expect(screen.getByText("Runs in attempt 2")).toBeTruthy();
    });
    expect(screen.getAllByText("Current task 1").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Historical task")).toHaveLength(0);
  });
});
