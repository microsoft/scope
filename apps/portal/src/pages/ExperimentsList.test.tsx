// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import type { ExperimentView } from "@/lib/experiments";

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    api: {
      ...original.api,
      listExperiments: vi.fn(),
    },
  };
});

import { api } from "@/lib/api";
import { ExperimentsList } from "./ExperimentsList";

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

class IntersectionObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

function experiment(
  experimentId: string,
  name: string,
  readiness: ExperimentView["readiness"],
): ExperimentView {
  return {
    experimentId,
    projectId: "project-1",
    metadata: {
      name,
      description: `${name} description`,
    },
    revision: {
      experimentRevisionId: `revision-${experimentId}`,
      revisionNumber: 1,
      memberCount: 2,
    },
    execution: {
      experimentExecutionId: `execution-${experimentId}`,
      attemptNumber: 1,
      requestCount: 2,
      requests: [],
      handlerProgress: {},
      blocking: [],
      createdAt: "2026-10-16T10:00:00.000Z",
    },
    readiness,
    blocking: [],
    createdRequestIds: [],
    createdAt: "2026-10-16T09:00:00.000Z",
  };
}

const firstPage = [
  experiment("experiment-alpha", "Alpha benchmark", "done"),
  experiment("experiment-beta", "Beta benchmark", "blocked"),
];
const secondPage = [
  experiment("experiment-gamma", "Gamma benchmark", "processing"),
];

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderList() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/experiments"]}>
        <Routes>
          <Route path="/experiments" element={<ExperimentsList />} />
          <Route path="/experiments/:id" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverMock,
  });
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: IntersectionObserverMock,
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("ExperimentsList", () => {
  it("includes deleted Experiments on demand and preserves deleted navigation", async () => {
    const deletedExperiment = {
      ...experiment("experiment-deleted", "Deleted benchmark", "done"),
      deletedAt: "2026-10-16T12:00:00.000Z",
      lifecycle: {
        operationId: "operation-delete",
        phase: "deleted" as const,
        stateVersion: 3,
        progress: {
          expectedRequests: 2,
          completedRequests: 2,
          expectedReports: 1,
          completedReports: 1,
        },
        blocking: [],
      },
    };
    vi.mocked(api.listExperiments)
      .mockResolvedValueOnce({ items: firstPage })
      .mockResolvedValueOnce({ items: [deletedExperiment] });
    renderList();

    fireEvent.click(
      await screen.findByRole("button", { name: "Show deleted" }),
    );
    expect(
      (await screen.findAllByText("Deleted benchmark")).length,
    ).toBeGreaterThan(0);
    expect(api.listExperiments).toHaveBeenLastCalledWith({
      cursor: undefined,
      includeDeleted: true,
      limit: 25,
    });
    fireEvent.click(screen.getAllByText("Deleted benchmark")[0]);
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        "/experiments/experiment-deleted",
      );
    });
  });

  it("uses the shared list controls for filtering and customization", async () => {
    vi.mocked(api.listExperiments).mockResolvedValue({
      items: firstPage,
      nextCursor: "next-page",
    });
    renderList();

    expect((await screen.findAllByText("Alpha benchmark")).length).toBeGreaterThan(0);
    expect(screen.getByRole("complementary", { name: "Filters" })).toBeTruthy();
    const listShell = screen.getByRole("heading", {
      name: "Experiments",
    }).closest("section")?.parentElement;
    expect(listShell?.className).toContain("h-full");
    expect(listShell?.className).not.toContain("px-6");

    fireEvent.change(screen.getByPlaceholderText("Search experiments…"), {
      target: { value: "Beta" },
    });
    expect(screen.queryAllByText("Alpha benchmark")).toHaveLength(0);
    expect(screen.getAllByText("Beta benchmark").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Customize Columns" }));
    expect(
      screen.getByRole("complementary", { name: "Customize columns" }),
    ).toBeTruthy();
  });

  it("keeps cursor pagination and row navigation", async () => {
    vi.mocked(api.listExperiments).mockImplementation(async ({ cursor } = {}) =>
      cursor === "next-page"
        ? { items: secondPage }
        : { items: firstPage, nextCursor: "next-page" },
    );
    renderList();

    expect((await screen.findAllByText("Alpha benchmark")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect((await screen.findAllByText("Gamma benchmark")).length).toBeGreaterThan(0);
    expect(api.listExperiments).toHaveBeenLastCalledWith({
      cursor: "next-page",
      includeDeleted: false,
      limit: 25,
    });

    fireEvent.click(screen.getAllByText("Gamma benchmark")[0]);
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        "/experiments/experiment-gamma",
      );
    });
  });
});
