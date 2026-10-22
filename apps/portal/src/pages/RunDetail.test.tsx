// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { Run, RunState } from "@/types";
import { api } from "@/lib/api";
import { RunDetail } from "./RunDetail";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./RunDetail.stories";

vi.mock("@/lib/api", () => ({
  api: {
    getRun: vi.fn(),
    getRunReports: vi.fn(async () => []),
    listReportTemplates: vi.fn(async () => []),
    logsUrl: vi.fn(),
    archiveUrl: vi.fn(),
    videoUrl: vi.fn(() => "/demo.webm"),
  },
}));
vi.mock("@/hooks/use-log-stream", () => ({
  useLogStream: () => ({
    logs: [], isConnected: false, isDone: true, error: null,
  }),
}));
vi.mock("@/components/TurnTimeline", () => ({ TurnTimeline: () => null }));

const turn = {
  iteration: 1,
  judgeFeedback: "",
  snapshotUrl: "",
  passed: true,
  timestamp: "2026-01-01T00:00:00.000Z",
};

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function renderDetail(state: Partial<RunState>, path = "/runs/demo") {
  const run: Run = {
    _id: "demo",
    id: "demo",
    workerType: "coder-acp-copilot",
    createdAt: turn.timestamp,
    run: { _id: "attempt-1", attemptNumber: 1, status: "done", ...state },
  };
  vi.mocked(api.getRun).mockResolvedValue(run);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Location />
        <Routes>
          <Route path="/runs/:id/:tab?" element={<RunDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function tabNames() {
  const list = await screen.findByRole("tablist");
  return within(list).getAllByRole("tab").map((tab) => tab.textContent);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RunDetail tabs", () => {
  it("orders every tab with Videos before Logs and keeps Turns selected", async () => {
    renderDetail({ turns: [turn], harUrl: "har.json", videoUrls: ["video.webm"] });

    expect(await tabNames()).toEqual([
      "Details", "Turns (1)", "Conversation", "Reports ", "Network", "Tool Calls", "Videos (1)", "Logs",
    ]);
    expect(screen.getByRole("tab", { name: "Turns (1)" }).getAttribute("aria-selected")).toBe("true");
  });

  describe("RunDetail stories", () => {
    const { AllTabs, WithoutArtifacts } = composeStories(stories);

    it("runs the all-tabs story assertions", async () => {
      const { container } = render(<MemoryRouter><AllTabs /></MemoryRouter>);
      await stories.AllTabs.play?.({ canvas: within(container) });
    });

    it("runs the no-artifacts story assertions", async () => {
      const { container } = render(<MemoryRouter><WithoutArtifacts /></MemoryRouter>);
      await stories.WithoutArtifacts.play?.({ canvas: within(container) });
    });
  });

  it.each(["pending", "processing", "done"] as const)(
    "hides artifact tabs without data and keeps Logs selected for a %s run without turns",
    async (status) => {
      renderDetail({ status });

      expect(await tabNames()).toEqual(["Details", "Turns ", "Reports ", "Logs"]);
      expect(screen.getByRole("tab", { name: "Logs" }).getAttribute("aria-selected")).toBe("true");
    },
  );

  it("keeps Conversation visible without HAR or video data", async () => {
    renderDetail({ turns: [turn] });

    expect(await tabNames()).toEqual(["Details", "Turns (1)", "Conversation", "Reports ", "Logs"]);
  });

  it("preserves turn-level artifacts and setup videos", async () => {
    renderDetail({ turns: [{ ...turn, harUrl: "turn.har", videoUrls: ["turn.webm"] }], setupVideoUrls: ["setup.webm"] });

    expect(await tabNames()).toEqual([
      "Details", "Turns (1)", "Conversation", "Reports ", "Network", "Tool Calls", "Videos (2)", "Logs",
    ]);
  });

  it("honors explicit tab routes and preserves the attempt query when switching tabs", async () => {
    renderDetail({ turns: [turn] }, "/runs/demo/reports?runId=attempt-1");
    await tabNames();

    expect(screen.getByRole("tab", { name: "Reports" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Details" }), { button: 0, ctrlKey: false });

    expect(screen.getByTestId("location").textContent).toBe("/runs/demo/details?runId=attempt-1");
    expect(screen.getByRole("tab", { name: "Details" }).getAttribute("aria-selected")).toBe("true");
  });
});
