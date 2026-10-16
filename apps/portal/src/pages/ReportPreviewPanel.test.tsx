// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Report } from "@/types";

const report: Report = {
  _id: "report-1",
  id: "report-1",
  submissionId: "submission-1",
  submissionRunId: "submission-run-1",
  status: "completed",
  content: "# Generated report",
  reporter: {
    id: "pp-readout",
    name: "Submission Readout",
    gitHash: "development",
    model: "gpt-5.4",
    agentId: "unknown",
    agentVersion: "unknown",
  },
  createdAt: "2026-01-01T00:00:00.000Z",
};

vi.mock("@/lib/api", () => ({
  api: {
    getReport: vi.fn(async () => report),
  },
}));

import { ReportPreviewPanel } from "./ReportPreviewPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ReportPreviewPanel submission reports", () => {
  it("identifies a template-less report without using report-type terminology", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/reports/report-1/preview"]}>
          <Routes>
            <Route path="/reports/:id/preview" element={<ReportPreviewPanel />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("template-less")).toBeDefined();
    expect(screen.queryByText("default template")).toBeNull();
  });
});
