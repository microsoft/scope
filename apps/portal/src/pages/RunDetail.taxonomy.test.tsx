// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { runNavigationState } from "@/lib/run-navigation";

const mocks = vi.hoisted(() => ({
  getRun: vi.fn(),
  listRunAttempts: vi.fn(),
  getTaxonomyEvaluationJson: vi.fn(),
  getRunReports: vi.fn(),
  listReportTemplates: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    api: {
      ...original.api,
      getRun: mocks.getRun,
      listRunAttempts: mocks.listRunAttempts,
      getTaxonomyEvaluationJson: mocks.getTaxonomyEvaluationJson,
      getRunReports: mocks.getRunReports,
      listReportTemplates: mocks.listReportTemplates,
    },
  };
});
vi.mock("@/hooks/use-log-stream", () => ({
  useLogStream: () => ({
    logs: [],
    isConnected: false,
    isDone: true,
    error: null,
  }),
}));

import { RunDetail } from "./RunDetail";

const taxonomyResult = {
  run: {
    id: "run-1",
    scenario: { id: "scenario-1", label: "Scenario" },
    profile: { id: "profile-1", label: "Profile" },
  },
  results: [
    {
      status: "succeeded",
      taxonomy: {
        id: "ax-taxonomy",
        version: "1.0.0",
        digest: "a".repeat(64),
      },
      element: { id: "element-1", label: "Observed behavior" },
      implementation: {
        type: "deterministic",
        handler: "element-1",
        attempts: [{ attempt: 1, kind: "initial", outcome: "succeeded" }],
      },
      input: { sha256: "b".repeat(64) },
      result: { state: "completed", observed: false },
    },
  ],
};

function runDocument(resultAvailable = true) {
  return {
    _id: "request-1",
    scenario: { task: "Test task", criteria: [] },
    workerType: "coder-acp-copilot",
    model: "model",
    createdAt: "2026-10-29T12:00:00.000Z",
    run: {
      _id: "run-1",
      status: "done",
      handlerStatus: {
        "pp-taxonomy": {
          status: "done",
          version: "1",
          updatedAt: "2026-10-29T12:01:00.000Z",
          claimToken: "claim-1",
        },
      },
      ...(resultAvailable
        ? {
            taxonomyEvaluation: {
              url: "https://storage.example/result.json.gz",
              schemaVersion: "2",
              contentSha256: "c".repeat(64),
              sizeBytes: 123,
            },
          }
        : {}),
    },
  };
}

function renderDetail(options?: { path?: string; state?: unknown }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={[
          {
            pathname: options?.path ?? "/runs/request-1/taxonomy",
            state: options?.state,
          },
        ]}
      >
        <Routes>
          <Route path="/runs/:id/:tab?" element={<RunDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RunDetail Taxonomy tab", () => {
  beforeEach(() => {
    mocks.getRun.mockResolvedValue(runDocument());
    mocks.listRunAttempts.mockResolvedValue([]);
    mocks.getTaxonomyEvaluationJson.mockResolvedValue(taxonomyResult);
    mocks.getRunReports.mockResolvedValue([]);
    mocks.listReportTemplates.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads and renders the validated typed result for the exact run", async () => {
    const user = userEvent.setup();
    renderDetail({
      path: "/runs/request-1",
      state: runNavigationState(
        "/experiments/experiment-1?tab=runs&executionId=execution-1",
        "Back to experiment",
      ),
    });
    await user.click(await screen.findByRole("tab", { name: "Taxonomy" }));

    expect(await screen.findByText("Taxonome result")).toBeTruthy();
    expect(screen.getByText("Observed behavior")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(mocks.getTaxonomyEvaluationJson).toHaveBeenCalledWith(
      "request-1",
      "run-1",
    );
    expect(screen.getByRole("link", { name: "Download JSON" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Back to experiment" }).getAttribute(
        "href",
      ),
    ).toBe(
      "/experiments/experiment-1?tab=runs&executionId=execution-1",
    );
  });

  it("shows result unavailable without fetching a blob when no reference exists", async () => {
    mocks.getRun.mockResolvedValue(runDocument(false));
    renderDetail();

    expect(await screen.findByText("Result unavailable")).toBeTruthy();
    expect(mocks.getTaxonomyEvaluationJson).not.toHaveBeenCalled();
  });
});
