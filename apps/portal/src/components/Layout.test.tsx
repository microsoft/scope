// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthContext } from "@/contexts/AuthContext";
import { signedInAuth } from "@/contexts/authFixtures";
import { ProjectProvider } from "@/contexts/ProjectContext";
import { PROJECT_STORAGE_KEY } from "@/lib/project-scope";
import { Layout } from "./Layout";

// The portal defines these build-time constants via Vite `define`; the root
// Vitest run doesn't apply that config, so stub them for <VersionFooter />.
beforeAll(() => {
  vi.stubGlobal("__GIT_COMMIT__", "test-commit");
  vi.stubGlobal("__BUILD_TIME__", "1970-01-01T00:00:00Z");
  vi.stubGlobal("__GIT_BRANCH__", "test-branch");
  // <VersionFooter /> and <ProjectSwitcher /> fire data fetches on mount; make
  // them reject fast (handled by their own catch/react-query) so no request is
  // left pending to abort at teardown and spam the log.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("network disabled in test"))),
  );
});

function renderLayout(
  path = "/runs",
  { projectId = "proj-1" }: { projectId?: string | null } = {},
) {
  // Layout gates project-scoped nav on a selected project, so seed one by
  // default; pass { projectId: null } to exercise the no-project state.
  if (projectId) localStorage.setItem(PROJECT_STORAGE_KEY, projectId);
  // Layout now hosts <ProjectSwitcher /> (react-query + ProjectContext) and
  // <UserMenu /> (AuthContext). Use an already-resolved Scope identity.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={signedInAuth}>
        <ThemeProvider defaultTheme="light">
          <ProjectProvider>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route element={<Layout />}>
                  <Route path="/" element={<div>Home page</div>} />
                  <Route path="/runs" element={<div>Runs page</div>} />
                </Route>
              </Routes>
            </MemoryRouter>
          </ProjectProvider>
        </ThemeProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Layout", () => {
  it("shows the disclosure footer on full-bleed routes", () => {
    renderLayout("/runs");

    expect(
      screen.getByText(/This is an AI evaluation platform\./),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Data collection and privacy" }),
    ).toBeTruthy();
  });

  it("expands the desktop sidebar to show navigation labels", () => {
    renderLayout();

    const sidebar = screen.getByLabelText("Primary navigation");
    expect(within(sidebar).queryByText("Activity")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
    expect(localStorage.getItem("scope:layout:sidebar-expanded")).toBe("0");

    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));

    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
    expect(within(sidebar).getByText("Activity")).toBeTruthy();
    expect(within(sidebar).getByRole("link", { name: "Runs" })).toBeTruthy();
    expect(localStorage.getItem("scope:layout:sidebar-expanded")).toBe("1");
  });

  it("honors the stored expanded state on first render", () => {
    localStorage.setItem("scope:layout:sidebar-expanded", "1");

    renderLayout();

    const sidebar = screen.getByLabelText("Primary navigation");
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
    expect(within(sidebar).getByText("Activity")).toBeTruthy();
  });

  it("labels the prompt library nav item 'Prompts' linking to /task-prompts", () => {
    localStorage.setItem("scope:layout:sidebar-expanded", "1");

    renderLayout();

    const sidebar = screen.getByLabelText("Primary navigation");
    const promptsLink = within(sidebar).getByRole("link", { name: "Prompts" });
    expect(promptsLink.getAttribute("href")).toBe("/task-prompts");
    // The legacy "Tasks" label must be gone.
    expect(within(sidebar).queryByRole("link", { name: "Tasks" })).toBeNull();
  });

  it("shows scoped nav and the New Run CTA when a project is selected", () => {
    localStorage.setItem("scope:layout:sidebar-expanded", "1");

    renderLayout("/runs");

    const sidebar = screen.getByLabelText("Primary navigation");
    // Scoped groups + the emphasized CTA are present with a project in use.
    expect(within(sidebar).getByRole("link", { name: "New Run" })).toBeTruthy();
    expect(within(sidebar).getByText("Activity")).toBeTruthy();
    expect(within(sidebar).getByRole("link", { name: "Runs" })).toBeTruthy();
    expect(within(sidebar).getByRole("link", { name: "MCP" })).toBeTruthy();
    // Global group is present too.
    expect(within(sidebar).getByText("Platform")).toBeTruthy();
  });

  it("hides project-scoped nav until a project is selected", () => {
    localStorage.setItem("scope:layout:sidebar-expanded", "1");

    renderLayout("/runs", { projectId: null });

    const sidebar = screen.getByLabelText("Primary navigation");
    // Global entries stay reachable without a selection.
    expect(within(sidebar).getByRole("link", { name: "Projects" })).toBeTruthy();
    expect(within(sidebar).getByText("Platform")).toBeTruthy();
    expect(within(sidebar).getByRole("link", { name: "Agents" })).toBeTruthy();
    expect(within(sidebar).getByRole("link", { name: "Models" })).toBeTruthy();
    expect(within(sidebar).getByRole("link", { name: "Secrets" })).toBeTruthy();
    // Scoped groups and their items are hidden.
    expect(within(sidebar).queryByText("Activity")).toBeNull();
    expect(within(sidebar).queryByText("Library")).toBeNull();
    expect(within(sidebar).queryByText("Resources")).toBeNull();
    expect(within(sidebar).queryByRole("link", { name: "Runs" })).toBeNull();
    expect(within(sidebar).queryByRole("link", { name: "Prompts" })).toBeNull();
    expect(within(sidebar).queryByRole("link", { name: "MCP" })).toBeNull();
    // The New Run CTA is scoped too, so it's gone until a project is picked.
    expect(within(sidebar).queryByRole("link", { name: "New Run" })).toBeNull();
  });

  it("routes home via the logo without de-scoping in Layout itself", () => {
    localStorage.setItem("scope:layout:sidebar-expanded", "1");

    renderLayout("/runs");

    // The logo is a plain link to the home route. De-scoping is HomeRoute's job
    // (so every path to `/` behaves the same), not this click handler's — a plain
    // click here must navigate without wiping the tab's selection.
    const logo = screen.getByRole("link", { name: "Scope home" });
    expect(logo.getAttribute("href")).toBe("/");

    fireEvent.click(logo);

    // Navigated to the (stubbed) home route, and Layout left the selection alone.
    expect(screen.getByText("Home page")).toBeTruthy();
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe("proj-1");
  });
});
