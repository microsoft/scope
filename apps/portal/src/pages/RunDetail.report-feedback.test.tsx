// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Run } from "@/types";
import { RunDetail } from "./RunDetail";

const completedRun: Run = {
  _id: "request-1",
  id: "request-1",
  workerType: "coder-acp-copilot",
  scenario: { task: "Build a sample app", criteria: [] },
  createdAt: "2026-01-01T00:00:00.000Z",
  run: { _id: "attempt-1", attemptNumber: 1, status: "done", outcome: "succeeded" },
};

vi.mock("@/lib/api", () => ({
  api: {
    getRun: vi.fn(),
    getRunReports: vi.fn(async () => []),
    listReportTemplates: vi.fn(async () => []),
    listAgents: vi.fn(async () => []),
    triggerReports: vi.fn(),
  },
}));

vi.mock("@/hooks/use-log-stream", () => ({
  useLogStream: () => ({ logs: [], isConnected: false, isDone: true, error: null }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function generateReport() {
  vi.mocked(api.getRun).mockResolvedValue(completedRun);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/runs/request-1/reports"]}>
        <Routes>
          <Route path="/runs/:id/:tab" element={<RunDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const button = await screen.findByRole("button", { name: "Generate Report" });
  await waitFor(() => expect(api.getRunReports).toHaveBeenCalledTimes(1));
  await userEvent.click(button);
}

describe("RunDetail report generation feedback", () => {
  it("warns when no reports were queued, explains the no-match case, and refreshes reports", async () => {
    vi.mocked(api.triggerReports).mockResolvedValue({ triggered: 0, reports: [] });

    await generateReport();

    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith("No reports queued", {
      description: "No active report template trigger matched this run. Review report template triggers and try again.",
    }));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(api.triggerReports).toHaveBeenCalledWith("request-1");
    await waitFor(() => expect(api.getRunReports).toHaveBeenCalledTimes(2));
  });

  it("preserves the actual queued count and refreshes reports when templates match", async () => {
    vi.mocked(api.triggerReports).mockResolvedValue({
      triggered: 2,
      reports: ["report-1", "report-2"].map((id) => ({
        id, requestId: "request-1", templateId: id, status: "pending",
      })),
    });

    await generateReport();

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("2 report(s) queued"));
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    await waitFor(() => expect(api.getRunReports).toHaveBeenCalledTimes(2));
  });

  it("preserves API errors without showing queued feedback", async () => {
    vi.mocked(api.triggerReports).mockRejectedValue(new Error("Report queue unavailable"));

    await generateReport();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Report queue unavailable"));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(api.getRunReports).toHaveBeenCalledTimes(1);
  });
});
