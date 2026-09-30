// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ResourceDocument, ResourceRevisionDocument } from "@/types";

const resource: ResourceDocument = {
  _id: "resource-1",
  projectId: "project-1",
  slug: "github-sim",
  name: "GitHub simulator",
  revisionCounter: 1,
  latestRevisionId: "revision-1",
  latestRevisionNumber: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const revisions: ResourceRevisionDocument[] = [
  {
    _id: "revision-1",
    resourceId: "resource-1",
    projectId: "project-1",
    slug: "github-sim",
    revisionNumber: 1,
    ref: "github-sim@r1",
    setup: { sh: "echo ok" },
    exports: ["SIMULATOR_URL"],
    parameters: [
      {
        name: "REPO",
        description: "Repository to simulate",
        required: true,
      },
      {
        name: "SCENARIO",
        description: "Scenario name",
        required: false,
        default: "public/repo",
      },
    ],
    contentSha256: "sha",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

vi.mock("@/lib/api", () => ({
  api: {
    getResource: vi.fn(async () => resource),
    listResourceRevisions: vi.fn(async () => revisions),
    getResourceRevision: vi.fn(async () => revisions[0]),
  },
}));

import { ResourceDetail } from "./ResourceDetail";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/resources/github-sim"]}>
        <Routes>
          <Route path="/resources/:id" element={<ResourceDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ResourceDetail parameters panel", () => {
  it("renders the revision parameter contract next to exports", async () => {
    renderDetail();

    expect(await screen.findByText("Parameters")).toBeTruthy();
    expect(screen.getByText("Inputs supplied before setup starts.")).toBeTruthy();
    expect(screen.getByText("REPO")).toBeTruthy();
    expect(screen.getByText("Repository to simulate")).toBeTruthy();
    expect(screen.getByText("default: public/repo")).toBeTruthy();
    expect(screen.getByText("Exports")).toBeTruthy();
    expect(screen.getByText("SIMULATOR_URL")).toBeTruthy();
  });
});
