// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/lib/api";
import { SubmitRun } from "./SubmitRun";
import { Instances } from "./SubmitRun.stories";

vi.mock("@/lib/api", () => ({
  api: {
    listAgents: vi.fn(async () => [{
      _id: "demo-agent",
      name: "Demo Agent",
      supportedModels: [],
      available: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      versions: [{
        agentVersion: "1.0.0",
        status: "active",
        queueName: "demo-queue",
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    }]),
    listMcpServers: vi.fn(async () => []),
    listProfiles: vi.fn(async () => []),
    listRuns: vi.fn(async () => ({ data: [], total: 0 })),
    listCriteria: vi.fn(async () => []),
    listTaskPrompts: vi.fn(async () => ({ items: [], total: 0 })),
    listModels: vi.fn(async () => []),
    getVersion: vi.fn(async () => ({ commit: "demo", buildTime: "" })),
    submitRun: vi.fn(async () => ({ id: "demo-run" })),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSubmitRun() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SubmitRun />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SubmitRun instances", () => {
  it("passes the Instances story interaction", async () => {
    const { container } = renderSubmitRun();
    await Instances.play({ canvas: within(container) });
  });

  it("labels repeated runs Instances and preserves the default and bounds", () => {
    renderSubmitRun();
    const instances = screen.getByRole("spinbutton", { name: "Instances" });
    expect(screen.queryByText("Occurrences")).toBeNull();
    expect(instances).toHaveProperty("value", "5");
    expect(screen.getByRole("button", { name: /Submit 5 Runs/ })).toBeTruthy();

    fireEvent.change(instances, { target: { value: "0" } });
    expect(instances).toHaveProperty("value", "1");
    expect(screen.getByRole("button", { name: /Submit Run/ })).toBeTruthy();

    fireEvent.change(instances, { target: { value: "11" } });
    expect(instances).toHaveProperty("value", "10");
    expect(screen.getByRole("button", { name: /Submit 10 Runs/ })).toBeTruthy();
  });

  it.each([1, 3])("preserves the API count contract for %i instances", async (count) => {
    renderSubmitRun();
    fireEvent.change(screen.getByLabelText("Task *"), { target: { value: "Say hello" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Max iterations" }), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Instances" }), {
      target: { value: String(count) },
    });
    const submit = screen.getByRole("button", {
      name: count === 1 ? /Submit Run/ : new RegExp(`Submit ${count} Runs`),
    });
    await waitFor(() => expect(submit).toHaveProperty("disabled", false));
    fireEvent.click(submit);
    await waitFor(() => expect(api.submitRun).toHaveBeenCalledOnce());
    const payload = vi.mocked(api.submitRun).mock.calls[0][0];
    expect(payload.count).toBe(count > 1 ? count : undefined);
    expect(payload).not.toHaveProperty("instances");
  });
});
