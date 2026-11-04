// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { runNavigationState } from "@/lib/run-navigation";

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    api: {
      ...original.api,
      getRun: vi.fn(async () => {
        throw new Error("Run not found");
      }),
      listRunAttempts: vi.fn(async () => []),
    },
  };
});

import { RunDetail } from "./RunDetail";

function renderDetail(state?: unknown) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/runs/request-1",
            state,
          },
        ]}
      >
        <Routes>
          <Route path="/runs/:id" element={<RunDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RunDetail return navigation", () => {
  afterEach(cleanup);

  it("returns to the exact Experiment origin", async () => {
    renderDetail(
      runNavigationState(
        "/experiments/experiment-1?tab=runs&executionId=execution-2",
        "Back to experiment",
      ),
    );

    expect(
      (
        await screen.findByRole("link", { name: "Back to experiment" })
      ).getAttribute("href"),
    ).toBe("/experiments/experiment-1?tab=runs&executionId=execution-2");
  });

  it("returns to the exact Runs query state", async () => {
    renderDetail(
      runNavigationState(
        "/runs?groupBy=experimentId&page=2",
        "Back to runs",
      ),
    );

    expect(
      (
        await screen.findByRole("link", { name: "Back to runs" })
      ).getAttribute("href"),
    ).toBe("/runs?groupBy=experimentId&page=2");
  });

  it.each([
    undefined,
    { returnTo: "https://example.com", returnLabel: "External" },
  ])("falls back to Runs for direct or invalid state %#", async (state) => {
    renderDetail(state);

    expect(
      (
        await screen.findByRole("link", { name: "Back to runs" })
      ).getAttribute("href"),
    ).toBe("/runs");
  });
});
