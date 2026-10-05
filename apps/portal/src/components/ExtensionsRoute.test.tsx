// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CodingAgent } from "@/types";
import { ExtensionsRoute } from "./ExtensionsRoute";

const listAgents = vi.fn<() => Promise<CodingAgent[]>>();
vi.mock("@/lib/api", () => ({ api: { listAgents: () => listAgents() } }));

function agent(supportsExtensions: boolean): CodingAgent {
  return {
    _id: supportsExtensions ? "vscode" : "cli",
    name: "Agent",
    available: true,
    supportedModels: [],
    capabilities: { supportsExtensions },
    versions: [
      {
        agentVersion: "v1",
        workerVersion: "v1",
        components: {},
        gitCommit: "abcdef0",
        buildTime: "20260101T000000Z",
        imageTag: "v1",
        queueName: "queue",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function renderRoute() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/extensions"]}>
        <Routes>
          <Route path="/extensions" element={<ExtensionsRoute><div>Extensions page</div></ExtensionsRoute>} />
          <Route path="/statistics" element={<div>Statistics page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  listAgents.mockReset();
});

describe("ExtensionsRoute", () => {
  it("renders nothing while the agent catalog loads", () => {
    listAgents.mockReturnValue(new Promise(() => {}));

    renderRoute();

    expect(screen.queryByText("Extensions page")).toBeNull();
    expect(screen.queryByText("Statistics page")).toBeNull();
  });

  it("redirects when no available agent supports extensions", async () => {
    listAgents.mockResolvedValue([agent(false)]);

    renderRoute();

    expect(await screen.findByText("Statistics page")).toBeTruthy();
    expect(screen.queryByText("Extensions page")).toBeNull();
  });

  it("redirects when the agent catalog fails to load", async () => {
    listAgents.mockRejectedValue(new Error("boom"));

    renderRoute();

    expect(await screen.findByText("Statistics page")).toBeTruthy();
  });

  it("renders the page when an available agent supports extensions", async () => {
    listAgents.mockResolvedValue([agent(false), agent(true)]);

    renderRoute();

    expect(await screen.findByText("Extensions page")).toBeTruthy();
  });
});
