// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { ProjectProvider, useSelectedProjectId } from "@/contexts/ProjectContext";
import { useSelectProject } from "@/hooks/useSelectProject";
import { getSelectedProjectId, PROJECT_STORAGE_KEY } from "@/lib/project-scope";
import { api } from "@/lib/api";
import type { Project } from "@/types";
import { ProjectGate } from "./ProjectGate";

vi.mock("@/lib/api", () => ({ api: { listProjects: vi.fn() } }));

const projects: Project[] = [
  { _id: "project-alpha", name: "Alpha", createdAt: "", updatedAt: "" },
  { _id: "project-bravo", name: "Bravo", createdAt: "", updatedAt: "" },
];
const fetchScoped = vi.fn(async () => getSelectedProjectId());
const renderedScopes: (string | undefined)[] = [];

function ScopedContent() {
  const selectedProjectId = useSelectedProjectId();
  const selectProject = useSelectProject();
  const { data } = useQuery({ queryKey: ["scoped-results"], queryFn: fetchScoped });
  renderedScopes.push(data);
  return (
    <>
      <p>Selected: {selectedProjectId}</p>
      <p>Results: {data}</p>
      <button onClick={() => selectProject("project-alpha")}>Switch to Alpha</button>
    </>
  );
}

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{location.pathname}{location.search}</output>
      <button onClick={() => navigate("/runs?projectId=project-bravo&submissionId=submission-2")}>
        Open another shared link
      </button>
    </>
  );
}

function renderGate(url: string, storedProjectId?: string) {
  if (storedProjectId) localStorage.setItem(PROJECT_STORAGE_KEY, storedProjectId);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (storedProjectId) client.setQueryData(["scoped-results"], storedProjectId);
  render(
    <QueryClientProvider client={client}>
      <ProjectProvider>
        <MemoryRouter initialEntries={[url]}>
          <LocationProbe />
          <ProjectGate><ScopedContent /></ProjectGate>
        </MemoryRouter>
      </ProjectProvider>
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  renderedScopes.length = 0;
});

describe("ProjectGate shared links", () => {
  it.each([undefined, "project-alpha"])(
    "selects the linked project before mounting scoped content (previous: %s)",
    async (storedProjectId) => {
      let resolveProjects!: (value: Project[]) => void;
      vi.mocked(api.listProjects).mockReturnValue(new Promise((resolve) => { resolveProjects = resolve; }));
      renderGate("/runs?projectId=project-bravo&submissionId=submission-1&groupBy=profile", storedProjectId);
      expect(screen.getByText("Opening shared project...")).toBeTruthy();
      expect(fetchScoped).not.toHaveBeenCalled();
      expect(renderedScopes).toEqual([]);

      resolveProjects(projects);
      await waitFor(() => expect(screen.getByText("Results: project-bravo")).toBeTruthy());
      expect(renderedScopes).not.toContain("project-alpha");
      expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe("project-bravo");
      await waitFor(() => expect(screen.getByTestId("location").textContent)
        .toBe("/runs?submissionId=submission-1&groupBy=profile"));
    },
  );

  it("does not pin later manual project switches to the consumed link", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listProjects).mockResolvedValue(projects);
    renderGate("/runs?projectId=project-bravo&submissionId=submission-1");
    await screen.findByText("Results: project-bravo");
    await waitFor(() => expect(screen.getByTestId("location").textContent).not.toContain("projectId"));
    await user.click(screen.getByRole("button", { name: "Switch to Alpha" }));
    await screen.findByText("Results: project-alpha");
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe("project-alpha");
  });

  it("honors a second shared link without reloading the app", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listProjects).mockResolvedValue(projects);
    renderGate("/runs", "project-alpha");
    await screen.findByText("Results: project-alpha");
    renderedScopes.length = 0;
    await user.click(screen.getByRole("button", { name: "Open another shared link" }));
    await screen.findByText("Results: project-bravo");
    expect(renderedScopes).not.toContain("project-alpha");
  });

  it.each(["missing-project", ""])("rejects unavailable or empty linked projects (%s)", async (id) => {
    vi.mocked(api.listProjects).mockResolvedValue(projects);
    renderGate(`/runs?projectId=${id}`, "project-alpha");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("unavailable"));
    expect(fetchScoped).not.toHaveBeenCalled();
    expect(renderedScopes).toEqual([]);
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe("project-alpha");
  });

  it("surfaces lookup errors and allows retry without using the previous project", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listProjects).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(projects);
    renderGate("/runs?projectId=project-bravo", "project-alpha");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not load"));
    expect(fetchScoped).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Results: project-bravo");
  });

  it("preserves existing project selection for ordinary URLs", () => {
    renderGate("/runs?submissionId=submission-1", "project-alpha");
    expect(screen.getByText("Results: project-alpha")).toBeTruthy();
    expect(api.listProjects).not.toHaveBeenCalled();
  });
});
