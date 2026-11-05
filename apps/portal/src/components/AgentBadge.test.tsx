// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

import type { CodingAgent } from "@/types";
import { AuthContext, type AuthContextValue } from "@/contexts/AuthContext";
import { anonymousAuth, signedInAuth } from "@/contexts/authFixtures";

const { listAgents } = vi.hoisted(() => ({
  listAgents: vi.fn<
    (options?: { includeDeleted?: boolean }) => Promise<CodingAgent[]>
  >(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    listAgents,
  },
}));

import { AgentBadge } from "./AgentBadge";

const activeAgent: CodingAgent = {
  _id: "coder-acp-copilot",
  name: "GitHub Copilot CLI",
  supportedModels: ["gpt-5.6-sol"],
  createdAt: "2026-01-01T00:00:00.000Z",
};

const adminAuth: AuthContextValue = { ...signedInAuth, user: signedInAuth.user && { ...signedInAuth.user,
  capabilities: { ...signedInAuth.user.capabilities, platformAdmin: true },
} };

function renderBadge(ui: ReactNode, auth: AuthContextValue = adminAuth) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}><MemoryRouter>{ui}</MemoryRouter></AuthContext.Provider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentBadge", () => {
  it("shows the registry name and links to agent detail", async () => {
    listAgents.mockResolvedValue([activeAgent]);
    renderBadge(<AgentBadge agentId={activeAgent._id} />);

    const link = await screen.findByRole("link", { name: activeAgent.name });
    expect(link.getAttribute("href")).toBe("/agents/coder-acp-copilot");
    expect(screen.queryByText(activeAgent._id)).toBeNull();
    expect(listAgents).toHaveBeenCalledWith({ includeDeleted: true });
  });

  it("shows the internal id and detail action on hover", async () => {
    listAgents.mockResolvedValue([activeAgent]);
    renderBadge(<AgentBadge agentId={activeAgent._id} />);

    await userEvent.hover(await screen.findByRole("link", { name: activeAgent.name }));
    expect((await screen.findAllByText(activeAgent._id)).length).toBeGreaterThan(0);
    expect(
      screen
        .getAllByRole("link", { name: /View agent/ })
        .some((link) => link.getAttribute("href") === "/agents/coder-acp-copilot"),
    ).toBe(true);
  });

  it("keeps selection triggers non-linking while preserving tooltip navigation", async () => {
    listAgents.mockResolvedValue([activeAgent]);
    renderBadge(<AgentBadge agentId={activeAgent._id} triggerLink={false} />);

    const trigger = await screen.findByText(activeAgent.name);
    expect(trigger.closest("a")).toBeNull();
    await userEvent.hover(trigger);
    expect(
      (await screen.findAllByRole("link", { name: /View agent/ })).length,
    ).toBeGreaterThan(0);
  });

  it("renders deleted agents by name with a deleted state", async () => {
    const deleted = { ...activeAgent, deletedAt: "2026-02-01T00:00:00.000Z" };
    listAgents.mockResolvedValue([deleted]);
    renderBadge(<AgentBadge agentId={deleted._id} />);

    await userEvent.hover(await screen.findByRole("link", { name: deleted.name }));
    expect((await screen.findAllByText("Deleted")).length).toBeGreaterThan(0);
  });

  it("renders an unknown label without a dead link", async () => {
    listAgents.mockResolvedValue([]);
    renderBadge(<AgentBadge agentId="missing-agent" />);

    await waitFor(() => expect(screen.getByText("Unknown agent")).toBeTruthy());
    expect(screen.queryByRole("link")).toBeNull();
    await userEvent.hover(screen.getByText("Unknown agent"));
    expect((await screen.findAllByText("missing-agent")).length).toBeGreaterThan(0);
  });

  it("uses preloaded agent data without waiting for the catalog", () => {
    renderBadge(<AgentBadge agentId={activeAgent._id} agent={activeAgent} variant="badge" />);

    expect(screen.getByRole("link", { name: activeAgent.name })).toBeTruthy();
    expect(listAgents).not.toHaveBeenCalled();
  });

  it("keeps catalog names and hover metadata for members without management links", async () => {
    listAgents.mockResolvedValue([activeAgent]);
    renderBadge(<AgentBadge agentId={activeAgent._id} version="example-version" />, signedInAuth);
    const label = await screen.findByText(activeAgent.name);
    expect(label.closest("a")).toBeNull();
    await userEvent.hover(label);
    expect((await screen.findAllByText(activeAgent._id)).length).toBeGreaterThan(0);
    expect(screen.getAllByText("example-version").length).toBeGreaterThan(0);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("View agent")).toBeNull();
    expect(listAgents).toHaveBeenCalledWith({ includeDeleted: true });
  });

  it("does not query or link the catalog while auth capabilities are resolving", () => {
    renderBadge(<AgentBadge agentId={activeAgent._id} />, {
      ...adminAuth, isReady: false, status: "resolving",
    });
    expect(listAgents).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keeps links in explicit auth-disabled mode", () => {
    renderBadge(<AgentBadge agentId={activeAgent._id} agent={activeAgent} />, anonymousAuth);
    expect(screen.getByRole("link", { name: activeAgent.name })).toBeTruthy();
  });
});
