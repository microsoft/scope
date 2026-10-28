// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
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
                  <Route
                    path="/experiments"
                    element={<div>Experiments page</div>}
                  />
                  <Route
                    path="/experiments/new"
                    element={<div>New experiment page</div>}
                  />
                  <Route
                    path="/experiments/:id"
                    element={<div>Experiment detail page</div>}
                  />
                  <Route path="/runs" element={<div>Runs page</div>} />
                  <Route path="/secrets/keys" element={
                    <div>
                      <Link to="/secrets/keys/demo-key/preview">Preview key</Link>
                      <Outlet />
                    </div>
                  }>
                    <Route path=":id/preview" element={
                      <Link to="/secrets/keys">Close preview</Link>
                    } />
                  </Route>
                  <Route path="/secrets/keys/new" element={<div>Register key</div>} />
                  <Route path="/secrets/keys/:id" element={<div>Key details</div>} />
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
  it("keeps the full-bleed shell when opening and closing a key preview", () => {
    renderLayout("/secrets/keys");

    const listClasses = screen.getByRole("main").className;
    expect(listClasses).not.toContain("px-6");

    fireEvent.click(screen.getByRole("link", { name: "Preview key" }));
    expect(screen.getByRole("link", { name: "Close preview" })).toBeTruthy();
    expect(screen.getByRole("main").className).toBe(listClasses);

    fireEvent.click(screen.getByRole("link", { name: "Close preview" }));
    expect(screen.getByRole("main").className).toBe(listClasses);
  });

  it("uses the full-bleed shell on a directly opened key preview", () => {
    renderLayout("/secrets/keys/demo-key/preview");

    expect(screen.getByRole("link", { name: "Close preview" })).toBeTruthy();
    expect(screen.getByRole("main").className).not.toContain("px-6");
  });

  it.each(["/experiments/new", "/experiments/experiment-1"])(
    "keeps the conventional padded shell for %s",
    (route) => {
      renderLayout(route);

      expect(screen.getByRole("main").className).toContain("px-6");
      expect(screen.getByRole("main").className).toContain("py-6");
    },
  );

  it.each(["/secrets/keys/new", "/secrets/keys/demo-key"])(
    "preserves page padding for %s",
    (path) => {
      renderLayout(path);

      expect(screen.getByRole("main").className).toContain("px-6");
      expect(screen.getByRole("main").className).toContain("py-6");
    },
  );

  it("shows the disclosure footer on full-bleed routes", () => {
    renderLayout("/runs");

    expect(
      screen.getByText(/This is an AI evaluation platform\./),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Data collection and privacy" }),
    ).toBeTruthy();
  });

  it("uses the Runs full-bleed shell for Experiments", () => {
    const runs = renderLayout("/runs");
    const runsClasses = screen.getByRole("main").className;
    runs.unmount();

    renderLayout("/experiments");

    expect(screen.getByRole("main").className).toBe(runsClasses);
    expect(screen.getByRole("main").className).not.toContain("px-6");
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

  it("offers both creation workflows from the scoped primary launcher", () => {
    localStorage.setItem("scope:layout:sidebar-expanded", "1");

    renderLayout("/runs");

    const sidebar = screen.getByLabelText("Primary navigation");
    const newRun = within(sidebar).getByRole("link", { name: "New Run" });
    const newExperiment = within(sidebar).getByRole("link", {
      name: "New Experiment",
    });
    expect(newRun.getAttribute("href")).toBe("/runs/new");
    expect(newExperiment.getAttribute("href")).toBe("/experiments/new");
    newRun.focus();
    expect(document.activeElement).toBe(newRun);
    newExperiment.focus();
    expect(document.activeElement).toBe(newExperiment);
    expect(within(sidebar).getByText("Activity")).toBeTruthy();
    expect(within(sidebar).getByRole("link", { name: "Runs" })).toBeTruthy();
    const experimentsLink = within(sidebar).getByRole("link", {
      name: "Experiments",
    });
    const criteriaLink = within(sidebar).getByRole("link", {
      name: "Criteria",
    });
    expect(experimentsLink.querySelector(".lucide-atom")).toBeTruthy();
    expect(criteriaLink.querySelector(".lucide-flask-conical")).toBeTruthy();
    expect(experimentsLink.nextElementSibling).toBe(
      within(sidebar).getByRole("link", { name: "Runs" }),
    );
    expect(within(sidebar).getByRole("link", { name: "MCP" })).toBeTruthy();
    // The Integrations group holds Resources alongside MCP and Extensions; the
    // group and its Resources item deliberately no longer share a label.
    expect(within(sidebar).getByText("Integrations")).toBeTruthy();
    expect(within(sidebar).getByRole("link", { name: "Resources" })).toBeTruthy();
    // Global group is present too.
    expect(within(sidebar).getByText("Platform")).toBeTruthy();
  });

  it("reveals both folded launcher choices on pointer hover and keyboard focus", async () => {
    renderLayout("/runs");

    const launcher = screen.getByTestId("new-workflow-launcher");
    const trigger = within(launcher).getByRole("link", { name: "New Run" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 8,
      y: 100,
      left: 8,
      top: 100,
      right: 48,
      bottom: 140,
      width: 40,
      height: 40,
      toJSON: () => ({}),
    });
    expect(screen.queryByRole("group", { name: "New workflow choices" })).toBeNull();

    fireEvent.pointerMove(trigger, { clientX: 9, clientY: 120 });
    let tray = screen.getByRole("group", { name: "New workflow choices" });
    vi.spyOn(tray, "getBoundingClientRect").mockReturnValue({
      x: 8,
      y: 100,
      left: 8,
      top: 100,
      right: 274,
      bottom: 140,
      width: 266,
      height: 40,
      toJSON: () => ({}),
    });
    expect(within(tray).getByRole("link", { name: "New Run" }).getAttribute("href")).toBe(
      "/runs/new",
    );
    expect(
      within(tray).getByRole("link", { name: "New Experiment" }).getAttribute("href"),
    ).toBe("/experiments/new");
    const expandedPlus = within(tray).getByTestId("expanded-workflow-plus-tile");
    const runLabel = within(tray).getByTestId("expanded-workflow-run-label");
    expect(expandedPlus.className).toContain("h-10");
    expect(expandedPlus.className).toContain("w-10");
    expect(expandedPlus.nextElementSibling).toBe(runLabel);

    fireEvent.pointerMove(document, { clientX: 28, clientY: 120 });
    expect(screen.getByRole("group", { name: "New workflow choices" })).toBeTruthy();
    fireEvent.pointerMove(document, { clientX: 47, clientY: 120 });
    expect(screen.getByRole("group", { name: "New workflow choices" })).toBeTruthy();
    fireEvent.pointerMove(document, { clientX: 120, clientY: 120 });
    expect(screen.getByRole("group", { name: "New workflow choices" })).toBeTruthy();
    fireEvent.pointerMove(document, { clientX: 220, clientY: 120 });
    expect(screen.getByRole("group", { name: "New workflow choices" })).toBeTruthy();
    fireEvent.pointerMove(document, { clientX: 1000, clientY: 800 });
    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: "New workflow choices" }),
      ).toBeNull(),
    );

    trigger.focus();
    fireEvent.focusIn(trigger);
    tray = await screen.findByRole("group", { name: "New workflow choices" });
    const trayRun = within(tray).getByRole("link", { name: "New Run" });
    const trayExperiment = within(tray).getByRole("link", {
      name: "New Experiment",
    });
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(trayRun);
    await user.tab();
    expect(document.activeElement).toBe(trayExperiment);
    fireEvent.keyDown(trayExperiment, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: "New workflow choices" }),
      ).toBeNull(),
    );
    expect(document.activeElement).toBe(trigger);
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
    expect(within(sidebar).queryByText("Integrations")).toBeNull();
    expect(within(sidebar).queryByRole("link", { name: "Runs" })).toBeNull();
    expect(within(sidebar).queryByRole("link", { name: "Prompts" })).toBeNull();
    expect(within(sidebar).queryByRole("link", { name: "Resources" })).toBeNull();
    expect(within(sidebar).queryByRole("link", { name: "MCP" })).toBeNull();
    // The New Run CTA is scoped too, so it's gone until a project is picked.
    expect(within(sidebar).queryByRole("link", { name: "New Run" })).toBeNull();
    expect(
      within(sidebar).queryByRole("link", { name: "New Experiment" }),
    ).toBeNull();
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
