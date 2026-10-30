// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { TaxonomyListItem } from "@/types";

const taxonomies: TaxonomyListItem[] = [
  {
    _id: "builtin-root",
    projectId: "project-1",
    id: "ax-taxonomy",
    name: "Ax taxonomy",
    sourceType: "builtin",
    revisionCounter: 1,
    latestRevisionId: "builtin-revision",
    latestRevision: 1,
    ref: "ax-taxonomy@r1",
    version: "1.0.0",
    elementCount: 6,
    createdAt: "2026-10-01T00:00:00.000Z",
  },
  {
    _id: "user-root",
    projectId: "project-1",
    id: "team-taxonomy",
    name: "Team taxonomy",
    sourceType: "user",
    revisionCounter: 2,
    latestRevisionId: "user-revision",
    latestRevision: 2,
    ref: "team-taxonomy@r2",
    version: "1.2.0",
    elementCount: 3,
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  },
];

const apiMocks = vi.hoisted(() => ({
  listTaxonomies: vi.fn(),
  createTaxonomy: vi.fn(),
  copyTaxonomyRevision: vi.fn(),
  deleteTaxonomy: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
}));

import { TaxonomyList } from "./TaxonomyList";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderList() {
  apiMocks.listTaxonomies.mockResolvedValue(taxonomies);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/taxonomies"]}>
        <Routes>
          <Route path="/taxonomies" element={<TaxonomyList />} />
          <Route path="/taxonomies/:id" element={<div>Taxonomy detail route</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TaxonomyList", () => {
  it("renders one table row per taxonomy without loading the element catalog", async () => {
    renderList();

    expect((await screen.findAllByText("Ax taxonomy")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("ax-taxonomy@r1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("team-taxonomy@r2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Built-in · read-only").length).toBeGreaterThan(0);
    expect(screen.getAllByText("6").length).toBeGreaterThan(0);
    expect(apiMocks.listTaxonomies).toHaveBeenCalledOnce();
  });

  it("filters rows and navigates to the dedicated detail route", async () => {
    renderList();
    await screen.findAllByText("Ax taxonomy");

    fireEvent.change(screen.getByPlaceholderText("Search taxonomies…"), {
      target: { value: "Team" },
    });
    expect(screen.queryAllByText("Ax taxonomy")).toHaveLength(0);
    fireEvent.click(screen.getAllByText("Team taxonomy")[0]!);
    expect(await screen.findByText("Taxonomy detail route")).toBeTruthy();
  });
});
