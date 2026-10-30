// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { TaxonomyDetailDocument } from "@/types";

const detail: TaxonomyDetailDocument = {
  taxonomy: {
    _id: "taxonomy-root",
    projectId: "project-1",
    id: "team-taxonomy",
    name: "Team taxonomy",
    description: "Team-owned taxonomy",
    sourceType: "user",
    revisionCounter: 2,
    latestRevisionId: "taxonomy-revision-2",
    latestRevision: 2,
    createdAt: "2026-10-01T00:00:00.000Z",
  },
  selectedRevision: {
    _id: "taxonomy-revision-2",
    taxonomyId: "taxonomy-root",
    projectId: "project-1",
    id: "team-taxonomy",
    version: "1.2.0",
    sourceType: "user",
    revision: 2,
    ref: "team-taxonomy@r2",
    contentSha256: "2".repeat(64),
    schema_version: "scope/taxonomy/v1",
    surfaces: [],
    elements: [{ ref: "element-b@r1" }, { ref: "element-a@r1" }],
    createdAt: "2026-10-02T00:00:00.000Z",
  },
  revisions: [
    {
      _id: "taxonomy-revision-2",
      revision: 2,
      ref: "team-taxonomy@r2",
      version: "1.2.0",
      elementCount: 2,
      contentSha256: "2".repeat(64),
      createdAt: "2026-10-02T00:00:00.000Z",
      isLatest: true,
    },
    {
      _id: "taxonomy-revision-1",
      revision: 1,
      ref: "team-taxonomy@r1",
      version: "1.0.0",
      elementCount: 1,
      contentSha256: "1".repeat(64),
      createdAt: "2026-10-01T00:00:00.000Z",
      isLatest: false,
    },
  ],
  elements: [
    {
      position: 0,
      root: {
        _id: "element-root-b",
        projectId: "project-1",
        id: "element-b",
        name: "Element B",
        sourceType: "user",
        revisionCounter: 1,
        latestRevision: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      revision: {
        _id: "element-revision-b",
        elementId: "element-root-b",
        projectId: "project-1",
        id: "element-b",
        label: "Element B",
        description: "First authored element",
        sourceType: "user",
        revision: 1,
        ref: "element-b@r1",
        contentSha256: "b".repeat(64),
        implementation: { type: "prompt", prompt: "Original prompt" },
        preconditions: {},
        output: { evidence_roles: {} },
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    },
    {
      position: 1,
      root: {
        _id: "element-root-a",
        projectId: "project-1",
        id: "element-a",
        name: "Element A",
        sourceType: "builtin",
        revisionCounter: 1,
        latestRevision: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      revision: {
        _id: "element-revision-a",
        elementId: "element-root-a",
        projectId: "project-1",
        id: "element-a",
        label: "Element A",
        sourceType: "builtin",
        revision: 1,
        ref: "element-a@r1",
        contentSha256: "a".repeat(64),
        implementation: {
          type: "deterministic",
          handler: "scope/example-v1",
        },
        preconditions: {},
        output: { evidence_roles: {} },
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    },
  ],
};

const apiMocks = vi.hoisted(() => ({
  getTaxonomyDetail: vi.fn(),
  createTaxonomyElementRevision: vi.fn(),
  createTaxonomyRevision: vi.fn(),
  copyTaxonomyRevision: vi.fn(),
  deleteTaxonomy: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMocks }));

import { TaxonomyDetail } from "./TaxonomyDetail";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDetail(
  path = "/taxonomies/taxonomy-root",
  value: TaxonomyDetailDocument = detail,
) {
  apiMocks.getTaxonomyDetail.mockResolvedValue(value);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/taxonomies/:taxonomyId" element={<TaxonomyDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TaxonomyDetail", () => {
  it("renders only exact referenced elements in authored order", async () => {
    renderDetail();

    expect((await screen.findAllByText("team-taxonomy@r2")).length)
      .toBeGreaterThan(0);
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]!).getByText("Element B")).toBeTruthy();
    expect(within(rows[2]!).getByText("Element A")).toBeTruthy();
    expect(screen.queryByText("Unrelated element")).toBeNull();
    expect(screen.getAllByText("Deterministic").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Built-in · read-only").length)
      .toBeGreaterThan(0);
  });

  it("creates an element revision and a taxonomy revision when editing a prompt", async () => {
    apiMocks.createTaxonomyElementRevision.mockResolvedValue({
      ...detail.elements[0]!.revision,
      _id: "element-revision-b-2",
      revision: 2,
      ref: "element-b@r2",
      implementation: { type: "prompt", prompt: "Updated prompt" },
    });
    apiMocks.createTaxonomyRevision.mockResolvedValue({
      ...detail.selectedRevision,
      _id: "taxonomy-revision-3",
      revision: 3,
      ref: "team-taxonomy@r3",
      elements: [{ ref: "element-b@r2" }, { ref: "element-a@r1" }],
    });
    renderDetail();

    await screen.findByText("Team taxonomy");
    fireEvent.click(
      screen.getAllByRole("button", { name: "Edit prompt" })[0]!,
    );
    fireEvent.change(screen.getByLabelText("Prompt instruction"), {
      target: { value: "Updated prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create new revisions" }));

    await waitFor(() => {
      expect(apiMocks.createTaxonomyElementRevision).toHaveBeenCalledWith(
        "element-root-b",
        expect.objectContaining({
          implementation: { type: "prompt", prompt: "Updated prompt" },
        }),
      );
    });
    expect(apiMocks.createTaxonomyRevision).toHaveBeenCalledWith(
      "taxonomy-root",
      expect.objectContaining({
        elements: [{ ref: "element-b@r2" }, { ref: "element-a@r1" }],
      }),
    );
  });

  it("requests and marks a selected historical revision read-only", async () => {
    const historical = {
      ...detail,
      selectedRevision: {
        ...detail.selectedRevision,
        _id: "taxonomy-revision-1",
        revision: 1,
        ref: "team-taxonomy@r1",
        elements: [{ ref: "element-b@r1" }],
      },
      elements: [detail.elements[0]!],
    };
    renderDetail(
      "/taxonomies/taxonomy-root?revision=taxonomy-revision-1",
      historical,
    );

    expect(await screen.findByText("Historical")).toBeTruthy();
    expect(apiMocks.getTaxonomyDetail).toHaveBeenCalledWith(
      "taxonomy-root",
      "taxonomy-revision-1",
    );
    expect(screen.queryByRole("button", { name: "Edit prompt" })).toBeNull();
  });
});
