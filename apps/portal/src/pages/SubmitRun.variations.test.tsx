// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { CodingAgent, ProfileWithVersion } from "@/types";

vi.mock("@/hooks/useVisibleGates", () => {
  const gates = ["select"];
  return { useVisibleGates: () => gates };
});

vi.mock("@/lib/api", () => ({
  api: {
    listAgents: vi.fn(),
    listProfiles: vi.fn(),
    listProfileVersions: vi.fn(),
    listMcpServers: vi.fn(async () => []),
    listRuns: vi.fn(async () => ({ data: [] })),
    listModels: vi.fn(async () => []),
    listCriteria: vi.fn(async () => []),
    listTaskPrompts: vi.fn(async () => ({ data: [] })),
    getVersion: vi.fn(async () => ({})),
    submitRun: vi.fn(async () => ({ ids: ["run-1", "run-2"] })),
  },
}));

import { api } from "@/lib/api";
import { SubmitRun } from "./SubmitRun";

const createdAt = "2026-01-01T00:00:00.000Z";
const agent: CodingAgent = {
  _id: "coder-copilot",
  name: "GitHub Copilot",
  supportedModels: ["fast-model", "quality-model"],
  defaultModel: "fast-model",
  available: true,
  versions: [{
    agentVersion: "1.0",
    workerVersion: "1.0",
    components: {},
    gitCommit: "abc",
    buildTime: createdAt,
    imageTag: "test",
    queueName: "test-queue",
    status: "active",
    createdAt,
  }],
  createdAt,
};

function profile(id: string, name: string, model = "fast-model"): ProfileWithVersion {
  return {
    _id: id,
    name,
    latestVersion: 2,
    createdAt,
    version: {
      _id: `${id}-v2`,
      profileId: id,
      version: 2,
      workerType: agent._id,
      model,
      createdAt,
    },
  };
}

const profiles = [
  profile("base", "Baseline"),
  profile("fast", "Fast configuration"),
  profile("quality-id", "Quality configuration", "quality-model"),
  { ...profile("unavailable", "Unavailable configuration"), version: {
    ...profile("unavailable", "Unavailable configuration").version,
    workerType: "missing-agent",
  } },
];

let queryClient: QueryClient;

beforeEach(() => {
  vi.mocked(api.listAgents).mockResolvedValue([agent]);
  vi.mocked(api.listProfiles).mockResolvedValue(profiles);
  vi.mocked(api.listProfileVersions).mockImplementation(async (id) => {
    const version = profiles.find((item) => item._id === id)!.version;
    return [version, { ...version, _id: `${id}-v1`, version: 1 }];
  });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.clearAllMocks();
});

async function renderVariations() {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><SubmitRun /></MemoryRouter>
    </QueryClientProvider>,
  );
  const baseInput = await screen.findByLabelText("Base Profile");
  fireEvent.change(baseInput, { target: { value: "Baseline" } });
  await user.click(screen.getByRole("listitem"));
  await user.click(screen.getByRole("button", { name: "Add" }));
  return user;
}

describe("SubmitRun variation profile search", () => {
  it("uses the base profile's filtering mechanics and keeps the selected name visible", async () => {
    const user = await renderVariations();
    const input = screen.getByLabelText("Variation #1");

    for (const query of ["quality", "quality-id", "QUALITY-MODEL", "coder-copilot", " GitHub Copilot "]) {
      fireEvent.change(input, { target: { value: query } });
      expect(screen.getAllByRole("listitem").some((item) => item.textContent?.includes("Quality configuration"))).toBe(true);
      expect(screen.queryByText("Unavailable configuration")).toBeNull();
      expect(screen.getAllByRole("listitem").some((item) => item.textContent?.includes("Baseline"))).toBe(false);
    }

    await user.clear(input);
    await user.type(input, "does-not-exist");
    expect(screen.getByText("No matching profiles")).toBeTruthy();
    expect(within(input.closest(".rounded-md.border.p-3") as HTMLElement).getByText("Fast configuration")).toBeTruthy();

    await user.clear(input);
    await user.type(input, "quality-model");
    await user.keyboard("{Enter}");
    expect((screen.getByLabelText("Variation #1") as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.getByLabelText("Variation #1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add after Quality configuration" })).toBeTruthy();
  });

  it("excludes other variations but allows the current profile and supports keyboard dismissal", async () => {
    const user = await renderVariations();
    await user.click(screen.getByRole("button", { name: "Add after Fast configuration" }));
    const input = screen.getByLabelText("Variation #1");
    await user.click(input);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("listitem").textContent).toContain("Fast configuration");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listitem")).toBeNull();
    await user.click(input);
    await user.click(screen.getByLabelText("Base Profile"));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("preserves pinned versions and resets to the new profile's latest version before submission", async () => {
    const user = await renderVariations();
    const input = screen.getByLabelText("Variation #1");
    const row = input.closest(".rounded-md.border.p-3")!;
    const versionSelect = within(row as HTMLElement).getByRole("combobox");
    await waitFor(() => expect(api.listProfileVersions).toHaveBeenCalledWith("fast"));
    await user.click(versionSelect);
    await user.click(await screen.findByRole("option", { name: "v1" }));
    expect(versionSelect.textContent).toContain("v1");

    await user.type(input, "quality");
    await user.keyboard("{Enter}");
    const updatedRow = screen.getByLabelText("Variation #1").closest(".rounded-md.border.p-3")!;
    expect(within(updatedRow as HTMLElement).getByRole("combobox").textContent).toContain("v2");
    await user.click(within(updatedRow as HTMLElement).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "v1" }));

    fireEvent.change(screen.getByLabelText("Task *"), { target: { value: "Build a demo" } });
    fireEvent.change(screen.getByLabelText("Max iterations"), { target: { value: "1" } });
    await user.click(screen.getByRole("button", { name: /Submit .*Runs/ }));
    await waitFor(() => expect(api.submitRun).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "base@2",
      profileVariations: ["quality-id@1"],
    }), expect.anything()));
  }, 15_000);

  it("keeps unavailable selections visible but not selectable and blocks submission", async () => {
    const user = await renderVariations();
    queryClient.setQueryData(["agents", "include-deleted"], [{ ...agent, available: false }]);
    const input = screen.getByLabelText("Variation #1");
    await user.click(input);
    expect(screen.getByText("Fast configuration (unavailable)")).toBeTruthy();
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.getByText("No profiles available")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Task *"), { target: { value: "Build a demo" } });
    fireEvent.change(screen.getByLabelText("Max iterations"), { target: { value: "1" } });
    expect((screen.getByRole("button", { name: /Submit .*Runs/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
