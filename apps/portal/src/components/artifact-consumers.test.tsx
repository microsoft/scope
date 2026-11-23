// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnTimeline } from "./TurnTimeline";
import { CodebaseDetail } from "@/pages/CodebaseDetail";
import { api } from "@/lib/api";
import { downloadArtifact } from "@/lib/artifact-delivery";
import type { CodebaseDocument, CodebaseRevisionDocument, ConversationTurn } from "@/types";

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({
  isReady: true, user: { id: "u1" }, account: null,
}) }));
vi.mock("@/contexts/ProjectContext", () => ({ useSelectedProjectId: () => "project-1" }));
vi.mock("@/lib/artifact-delivery", () => ({ downloadArtifact: vi.fn(), downloadBatchArtifacts: vi.fn() }));

const turn: ConversationTurn = {
  iteration: 2, passed: true, timestamp: "2026-01-01T12:00:00Z",
  codingAgentResponse: "Stored response", judgeFeedback: "Passed",
  snapshotUrl: "https://storage.test/private-snapshot", harUrl: "https://storage.test/private-har",
  atifUrl: "https://storage.test/private-atif",
};
beforeEach(() => { vi.mocked(downloadArtifact).mockResolvedValue(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

describe("protected artifact consumers", () => {
  it.each(["current-attempt", "historical-attempt", undefined])("pins snapshot/HAR/ATIF to %s", async attempt => {
    render(<TurnTimeline runId="request-1" attemptRunId={attempt} turns={[turn]} />);
    for (const name of ["Snapshot", "HAR", "ATIF"]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    await waitFor(() => expect(downloadArtifact).toHaveBeenCalledTimes(3));
    const base = `/api/v1/requests/request-1${attempt ? `/runs/${attempt}` : ""}`;
    expect(vi.mocked(downloadArtifact).mock.calls.map(call => call[0])).toEqual([
      `${base}/snapshots/2`, `${base}/har?iteration=2`, `${base}/atif?iteration=2`,
    ]);
    expect(vi.mocked(downloadArtifact).mock.calls.every(call => call[1] === "project-1")).toBe(true);
    expect(screen.getByText("Stored response")).toBeDefined();
    expect(document.querySelector("a[href*='storage.test']")).toBeNull();
  });

  it("routes BOTH codebase archive controls through authenticated delivery rather than stored origins", async () => {
    const codebase: CodebaseDocument = {
      _id: "codebase-1", slug: "example", name: "Example", sourceType: "archive",
      revisionCounter: 1, createdAt: "2026-01-01T00:00:00Z",
    };
    const revision: CodebaseRevisionDocument = {
      _id: "revision-1", codebaseId: codebase._id, slug: "example", revisionNumber: 1,
      ref: "example@1", sourceType: "archive", archiveUrl: "https://foreign.test/stored-archive",
      createdAt: codebase.createdAt, resolvedAt: codebase.createdAt,
    };
    vi.spyOn(api, "getCodebase").mockResolvedValue(codebase);
    vi.spyOn(api, "listCodebaseRevisions").mockResolvedValue([revision]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/codebases/codebase-1"]}><Routes>
        <Route path="/codebases/:id" element={<CodebaseDetail />} />
      </Routes></MemoryRouter>
    </QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    fireEvent.click(screen.getByRole("button", { name: /\/api\/v1\/codebase-revisions\/revision-1\/archive/ }));
    await waitFor(() => expect(downloadArtifact).toHaveBeenCalledTimes(2));
    for (const call of vi.mocked(downloadArtifact).mock.calls) {
      expect(call[0]).toBe("/api/v1/codebase-revisions/revision-1/archive");
      expect(call[1]).toBe("project-1");
      expect(call[3]).toBe("example@1.tar.gz");
    }
    expect(document.querySelector("a[href*='foreign.test']")).toBeNull();
    client.clear();
  });
});
