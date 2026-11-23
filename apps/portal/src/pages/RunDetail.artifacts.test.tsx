// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "./RunDetail";
import { api } from "@/lib/api";
import { downloadArtifact } from "@/lib/artifact-delivery";
import { useLogStream } from "@/hooks/use-log-stream";
import type { Run, RunState } from "@/types";

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ isReady: true, user: { id: "u1" }, account: null }) }));
vi.mock("@/contexts/ProjectContext", () => ({ useSelectedProjectId: () => "p1" }));
vi.mock("@/hooks/use-log-stream", () => ({ useLogStream: vi.fn(() => ({
  logs: [], isConnected: false, isDone: true, error: null,
})) }));
vi.mock("@/components/CriteriaGraphView", () => ({ CriteriaGraphView: () => null }));
vi.mock("@/components/LogViewer", () => ({ LogViewer: () => null }));
vi.mock("@/lib/artifact-delivery", () => ({ downloadArtifact: vi.fn(), downloadBatchArtifacts: vi.fn() }));

const current: RunState = {
  _id: "current", attemptNumber: 1, status: "done", outcome: "succeeded",
  turns: [{ iteration: 1, passed: true, snapshotUrl: "stored-current", judgeFeedback: "",
    timestamp: "2026-01-01T00:00:00Z" }],
};
const run: Run = { _id: "request-1", id: "example", workerType: "copilot",
  createdAt: "2026-01-01T00:00:00Z", run: current };
const clients: QueryClient[] = [];
const unexpectedFetch = vi.fn(() => { throw new Error("Unexpected API request in isolated artifact test"); });
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}>
    <MemoryRouter initialEntries={["/runs/request-1?runId=historical"]}><Routes>
      <Route path="/runs/:id" element={<RunDetail />} />
    </Routes></MemoryRouter>
  </QueryClientProvider>);
}
beforeEach(() => {
  vi.spyOn(api, "getRun").mockResolvedValue(run);
  vi.spyOn(api, "getRunReports").mockResolvedValue([]);
  vi.spyOn(api, "listReportTemplates").mockResolvedValue([]);
  vi.spyOn(api, "listAgents").mockResolvedValue([]);
  vi.stubGlobal("fetch", unexpectedFetch);
  vi.mocked(downloadArtifact).mockResolvedValue();
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(unexpectedFetch).not.toHaveBeenCalled();
  vi.clearAllMocks();
});

describe("selected attempt artifact pinning", () => {
  it("does not expose the latest archive or logs while historical data is loading", async () => {
    vi.spyOn(api, "listRunAttempts").mockImplementation(() => new Promise(() => {}));
    mount();
    await screen.findByRole("status");
    expect(api.listRunAttempts).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Download Archive" })).toBeNull();
    expect(vi.mocked(useLogStream).mock.calls.every(([options]) => !options.enabled)).toBe(true);
  });

  it.each(["missing", "failed"] as const)("does not substitute the latest archive for %s history", async state => {
    const attempts = vi.spyOn(api, "listRunAttempts");
    if (state === "missing") attempts.mockResolvedValue([current]);
    else attempts.mockRejectedValue(new Error("HTTP 403"));
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain(
      state === "missing" ? "Selected run attempt not found" : "HTTP 403",
    );
    expect(screen.queryByRole("button", { name: "Download Archive" })).toBeNull();
    expect(downloadArtifact).not.toHaveBeenCalled();
  });

  it("uses the actual resolved historical attempt for the archive", async () => {
    vi.spyOn(api, "listRunAttempts").mockResolvedValue([{ ...current, _id: "historical" }, current]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Download Archive" }));
    await waitFor(() => expect(downloadArtifact).toHaveBeenCalledWith(
      "/api/v1/requests/request-1/runs/historical/archive", "p1", expect.any(AbortSignal), "request-1.tar.gz",
    ));
  });
});
