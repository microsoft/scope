// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ProjectProvider } from "@/contexts/ProjectContext";
import { useSelectProject } from "@/hooks/useSelectProject";
import { PROJECT_STORAGE_KEY } from "@/lib/project-scope";
import { api } from "@/lib/api";
import type { CodingAgent } from "@/types";
import { SubmitRun } from "./SubmitRun";

vi.mock("@/lib/api", () => ({
  api: {
    listAgents: vi.fn(),
    listMcpServers: async () => [],
    listProfiles: async () => [],
    listRuns: async () => ({ data: [] }),
    listModels: async () => [],
    listTaskPrompts: async () => ({ items: [] }),
    listCriteria: async () => [],
    listSkills: async () => [],
    listExtensions: async () => [],
    getVersion: async () => ({ strictAgentCapabilities: false }),
    submitRun: vi.fn(),
  },
}));

const agent: CodingAgent = {
  _id: "test-worker",
  name: "Test worker",
  supportedModels: [],
  available: true,
  createdAt: "",
  versions: [{
    agentVersion: "test-version",
    workerVersion: "1",
    queueName: "queue-test-worker",
    status: "active",
    createdAt: "",
    components: {},
    gitCommit: "",
    buildTime: "",
    imageTag: "",
  }],
};

function NavigationProbe() {
  const location = useLocation();
  const selectProject = useSelectProject();
  return (
    <>
      <span data-testid="location">{location.pathname}{location.search}</span>
      <button onClick={() => selectProject("project-bravo")}>Switch to Bravo</button>
    </>
  );
}

function renderSubmit() {
  localStorage.setItem(PROJECT_STORAGE_KEY, "project-alpha");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <ProjectProvider>
        <MemoryRouter initialEntries={["/runs/new"]}>
          <NavigationProbe />
          <Routes>
            <Route path="/runs/new" element={<SubmitRun />} />
            <Route path="/runs/*" element={<p>Results destination</p>} />
          </Routes>
        </MemoryRouter>
      </ProjectProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.listAgents).mockResolvedValue([agent]);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

async function fillTask(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Task *"), "A synthetic benchmark task");
  fireEvent.change(screen.getByLabelText("Max iterations"), { target: { value: "1" } });
}

describe("SubmitRun results navigation", () => {
  it("opens the submitted batch, including its project and all member runs", async () => {
    const user = userEvent.setup();
    vi.mocked(api.submitRun).mockResolvedValue({
      ids: ["run-1", "run-2", "run-3", "run-4", "run-5"],
      count: 5, submissionId: "submission-1", message: "Submitted",
    });
    renderSubmit();
    await fillTask(user);
    const submit = screen.getByRole("button", { name: /Submit 5 Runs/i });
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    await user.click(submit);
    await waitFor(() => expect(screen.getByTestId("location").textContent)
      .toBe("/runs?projectId=project-alpha&submissionId=submission-1&groupBy=profile"));
    expect(api.submitRun).toHaveBeenCalledWith(expect.objectContaining({ count: 5 }));
  });

  it("keeps the submitting project if the selection changes while the request is pending", async () => {
    const user = userEvent.setup();
    let resolveSubmit!: (value: Awaited<ReturnType<typeof api.submitRun>>) => void;
    vi.mocked(api.submitRun).mockReturnValue(new Promise((resolve) => { resolveSubmit = resolve; }));
    renderSubmit();
    await fillTask(user);
    const submit = screen.getByRole("button", { name: /Submit 5 Runs/i });
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    await user.click(submit);
    await user.click(screen.getByRole("button", { name: "Switch to Bravo" }));
    resolveSubmit({ ids: ["run-1"], count: 1, submissionId: "submission-1", message: "Submitted" });
    await waitFor(() => expect(screen.getByTestId("location").textContent)
      .toContain("projectId=project-alpha"));
  });

  it("still opens the detail page for a single run", async () => {
    const user = userEvent.setup();
    vi.mocked(api.submitRun).mockResolvedValue({
      _id: "run-1", id: "run-1", workerType: "test-worker", createdAt: "", message: "Submitted",
    });
    renderSubmit();
    await fillTask(user);
    fireEvent.change(screen.getByLabelText("Occurrences"), { target: { value: "1" } });
    const submit = screen.getByRole("button", { name: /^Submit Run/i });
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    await user.click(submit);
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/runs/run-1"));
  });
});
