// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ProjectProvider } from "@/contexts/ProjectContext";
import { PROJECT_STORAGE_KEY } from "@/lib/project-scope";
import { HomeRoute } from "./HomeRoute";
import { AuthContext } from "@/contexts/AuthContext";
import { signedInAuth } from "@/contexts/authFixtures";

// The picker lists projects via `api.listProjects`; return one so we can also
// exercise the pick -> forward path. Keep the rest of the facade real.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listProjects: vi
        .fn()
        .mockResolvedValue([{ _id: "proj-1", id: "proj-1", name: "Demo" }]),
    },
  };
});

beforeAll(() => {
  // Any stray fetch (none expected once listProjects is mocked) rejects fast so
  // nothing is left pending to abort at teardown.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("network disabled in test"))),
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderHome(initial = "/") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={signedInAuth}><ProjectProvider>
        <MemoryRouter initialEntries={[initial]}>
          <Routes>
            <Route path="/" element={<HomeRoute />} />
            <Route path="/statistics" element={<div>Statistics page</div>} />
          </Routes>
        </MemoryRouter>
      </ProjectProvider></AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe("HomeRoute", () => {
  it("clears an inherited project selection on arrival and shows the picker", async () => {
    // Arrive at `/` with a project already selected (e.g. from a prior scope).
    localStorage.setItem(PROJECT_STORAGE_KEY, "proj-1");

    renderHome("/");

    // The picker renders (no redirect to /statistics)…
    expect(screen.getByRole("heading", { name: "Select a project" })).toBeTruthy();
    expect(screen.queryByText("Statistics page")).toBeNull();
    // …and the inherited selection is cleared.
    await waitFor(() => expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBeNull());
  });

  it("shows the picker when arriving unscoped", async () => {
    renderHome("/");

    expect(screen.getByRole("heading", { name: "Select a project" })).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBeNull());
  });

  it("forwards to the scoped landing once a project is picked", async () => {
    renderHome("/");

    // Pick the (mocked) project from the picker.
    fireEvent.click(await screen.findByRole("button", { name: /Demo/ }));

    // Selecting sets the scope; HomeRoute forwards to /statistics.
    expect(await screen.findByText("Statistics page")).toBeTruthy();
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe("proj-1");
  });
});
