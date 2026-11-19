// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "@/lib/api";
import { RunDetail } from "./RunDetail";

vi.mock("@/hooks/use-log-stream", () => ({
  useLogStream: () => ({ logs: [], isConnected: false, isDone: true, error: null }),
}));
vi.mock("@/lib/api", () => ({ api: {
  getRun: vi.fn(), getRunReports: vi.fn(), listReportTemplates: vi.fn(),
  getReportEligibility: vi.fn(), triggerReports: vi.fn(), listAgents: vi.fn(),
} }));

function renderReports() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>
    <MemoryRouter initialEntries={["/runs/request-1/reports"]}>
      <Routes><Route path="/runs/:id/:tab" element={<RunDetail />} /></Routes>
    </MemoryRouter>
  </QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(api.getRun).mockResolvedValue({
    _id: "request-1", id: "request-1", workerType: "copilot", createdAt: "2026-01-01",
    scenario: { task: "Test task", criteria: [] },
    run: { _id: "attempt-2", attemptNumber: 1, status: "done", outcome: "succeeded" },
  });
  vi.mocked(api.listAgents).mockResolvedValue([]);
  vi.mocked(api.getRunReports).mockResolvedValue([]);
  vi.mocked(api.listReportTemplates).mockResolvedValue([]);
  vi.mocked(api.getReportEligibility).mockResolvedValue({ activeTemplateCount: 0, templates: [] });
  vi.mocked(api.triggerReports).mockResolvedValue({ triggered: 1, reports: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Run Details Reports tab", () => {
  it("explains template requirements and disables generation when no templates apply", async () => {
    renderReports();
    expect(await screen.findByText(/No active report templates are configured/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate Report" }).hasAttribute("disabled")).toBe(true);
    expect(api.getReportEligibility).toHaveBeenCalledWith("request-1");
    expect(screen.getByText("No reports for this run yet.")).toBeTruthy();
  });

  it("keeps manual and historical reports visible without eligible templates", async () => {
    vi.mocked(api.getRunReports).mockResolvedValue([
      { _id: "manual", id: "manual", requestId: "request-1", status: "pending", createdAt: "2026-01-01" },
      { _id: "historical", id: "historical", requestId: "request-1", templateId: "removed-template", status: "failed", createdAt: "2025-01-01" },
    ]);
    renderReports();
    expect(await screen.findByText("Manual report")).toBeTruthy();
    expect(screen.getByText("removed-template")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate Report" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows matching templates and sends generation to the same request", async () => {
    vi.mocked(api.getReportEligibility).mockResolvedValue({
      activeTemplateCount: 2, templates: [{ id: "quality", name: "Quality review" }],
    });
    renderReports();
    expect(await screen.findByText("Quality review")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Generate Report" }));
    await waitFor(() => expect(api.triggerReports).toHaveBeenCalledWith("request-1"));
  });
});
