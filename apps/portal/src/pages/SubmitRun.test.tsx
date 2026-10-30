// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ComponentProps, ReactNode } from "react";
import type { CreateCriterionDialog } from "@/components/CreateCriterionDialog";

vi.mock("@/lib/api", () => ({
  api: {
    listAgents: vi.fn(async () => []),
    listMcpServers: vi.fn(async () => []),
    listProfiles: vi.fn(async () => []),
    listProfileVersions: vi.fn(async () => []),
    listRuns: vi.fn(async () => ({ data: [] })),
    listModels: vi.fn(async () => []),
    listTaxonomies: vi.fn(async () => []),
    createExperiment: vi.fn(async () => ({ experimentId: "experiment-1" })),
  },
}));

vi.mock("@/hooks/useVisibleGates", () => ({
  useVisibleGates: () => [],
}));
vi.mock("@/hooks/useStrictAgentCapabilities", () => ({
  useStrictAgentCapabilities: () => false,
}));
vi.mock("@/hooks/useAdvancedMode", () => ({
  useAdvancedMode: () => [false, vi.fn()],
}));
vi.mock("@/hooks/useCommandEnter", () => ({
  useCommandEnter: vi.fn(),
  createCommandEnterKeyDown: () => () => undefined,
  isMac: false,
}));
vi.mock("@/components/ReasoningEffortSelect", () => ({
  ModelSelectItems: () => null,
  ReasoningEffortSelect: () => null,
  useModelCapabilities: () => ({
    capabilitiesMap: new Map(),
    activeModelIds: ["gpt-6.1-sol"],
    capabilitiesLoaded: true,
  }),
  useReasoningEffort: () => ({
    supportedEfforts: [],
    workerEffortWarning: undefined,
  }),
}));
vi.mock("@/components/TaskPromptPicker", () => ({
  TaskPromptPicker: () => null,
}));
vi.mock("@/components/CriteriaPicker", () => ({
  CriteriaPicker: ({
    trailingAction,
    inputId,
    selected,
  }: {
    trailingAction?: ReactNode;
    inputId?: string;
    selected: string[];
  }) => (
    <div data-testid={inputId}>
      {selected.join(", ")}
      {trailingAction}
    </div>
  ),
}));
vi.mock("@/components/CreateCriterionDialog", () => ({
  CreateCriterionDialog: ({
    open,
    mode,
    onCreated,
    defaultGates,
    lockedGates,
  }: ComponentProps<typeof CreateCriterionDialog>) =>
    open ? (
      <div role="dialog">
        <span>{mode ?? "criteria"}</span>
        <span data-testid="default-gates">{defaultGates?.join(",")}</span>
        <span data-testid="locked-gates">{lockedGates?.join(",")}</span>
        <button onClick={() => onCreated("new_observation")}>
          Complete creation
        </button>
      </div>
    ) : null,
}));
vi.mock("@/components/SkillPicker", () => ({
  SkillPicker: () => null,
}));
vi.mock("@/components/CodebasePicker", () => ({
  CodebasePicker: () => null,
}));
vi.mock("@/components/ResourcePicker", () => ({
  ResourcePicker: () => null,
}));
vi.mock("@/components/ExtensionPicker", () => ({
  ExtensionPicker: () => null,
}));
vi.mock("@/components/ProfilePicker", () => ({
  ProfilePicker: () => null,
}));
vi.mock("@/components/ProfileCreateForm", () => ({
  ProfileCreateForm: () => null,
}));
vi.mock("@/components/AgentBadge", () => ({
  AgentBadge: () => null,
}));

import { SubmitRun } from "./SubmitRun";
import { api } from "@/lib/api";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSubmitRun(mode?: "experiment") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SubmitRun mode={mode} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SubmitRun Observation creation", () => {
  it("opens the specialized shared wizard and selects the created observation only", async () => {
    renderSubmitRun();

    fireEvent.click(
      await screen.findByRole("button", { name: "New Observation" }),
    );
    expect(screen.getByText("observation", { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Complete creation" }));
    expect(screen.getByTestId("observations").textContent).toContain(
      "new_observation",
    );
    expect(screen.getByTestId("criteria").textContent).not.toContain(
      "new_observation",
    );
  });

  it("keeps requirements creation generic with locked Select gates", async () => {
    renderSubmitRun();

    fireEvent.click(
      within(screen.getByTestId("criteria")).getByRole("button", {
        name: "New…",
      }),
    );
    expect(screen.getByText("criteria", { exact: true })).toBeTruthy();
    expect(screen.getByTestId("default-gates").textContent).toBe("select");
    expect(screen.getByTestId("locked-gates").textContent).toBe("select");
  });

  it("opens the shared Observation wizard from New Experiment", async () => {
    renderSubmitRun("experiment");

    fireEvent.change(screen.getByLabelText(/Task/), {
      target: { value: "Implement the benchmark task" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "New Observation" }),
    );

    expect(screen.getByText("observation", { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Complete creation" }));
    expect(screen.getByTestId("observations").textContent).toContain(
      "new_observation",
    );
    expect(screen.getByTestId("criteria").textContent).not.toContain(
      "new_observation",
    );
  });
});

describe("SubmitRun legacy composition guidance", () => {
  it("keeps neutral guidance beside composition controls", async () => {
    renderSubmitRun();

    const link = await screen.findByRole("link", { name: "New Experiment" });
    const guidance = link.parentElement;
    expect(guidance?.textContent).toBe(
      "Creating multiple runs or profile variations? Use New Experiment.",
    );
    expect(guidance?.className).toContain("bg-muted/30");
    expect(guidance?.className).not.toContain("amber");
    expect(guidance?.getAttribute("role")).toBeNull();
    expect(link.getAttribute("href")).toBe("/experiments/new");
    expect(screen.queryByText(/legacy-request-composition/)).toBeNull();
    expect(screen.queryByText(/Deprecated composition/)).toBeNull();
    expect(
      guidance?.previousElementSibling?.querySelector("#occurrences"),
    ).toBeTruthy();
  });
});

describe("SubmitRun Experiment composition", () => {
  it("submits a worker and model for a composed experiment", async () => {
    vi.mocked(api.listAgents).mockResolvedValue([{
      _id: "coder-acp-copilot",
      name: "GitHub Copilot CLI",
      description: "Copilot worker",
      modelProvider: "github-copilot",
      supportedModels: ["gpt-6.1-sol"],
      defaultModel: "gpt-6.1-sol",
      available: true,
      capabilities: {},
      versions: [{
        agentVersion: "copilot-dev",
        workerVersion: "development",
        components: {},
        gitCommit: "development",
        buildTime: new Date().toISOString(),
        imageTag: "development",
        status: "active",
        queueName: "queue-coder-acp-copilot",
        createdAt: new Date().toISOString(),
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }]);
    renderSubmitRun("experiment");

    fireEvent.change(screen.getByLabelText("Name *"), {
      target: { value: "Copilot comparison" },
    });
    fireEvent.change(screen.getByLabelText(/Task/), {
      target: { value: "Build a hello-world CLI" },
    });
    fireEvent.change(screen.getByLabelText("Max iterations"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText("Occurrences"), {
      target: { value: "1" },
    });

    const submit = await screen.findByRole("button", {
      name: /Create experiment with 1 run/,
    });
    await waitFor(() =>
      expect((submit as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(submit);

    await waitFor(() => {
      expect(api.createExperiment).toHaveBeenCalledWith({
        metadata: { name: "Copilot comparison" },
        reportTemplateIds: [],
        request: expect.objectContaining({
          scenario: {
            task: "Build a hello-world CLI",
            criteria: [],
          },
          worker: "coder-acp-copilot",
          model: "gpt-6.1-sol",
          agentVersion: "copilot-dev",
          maxIterations: 1,
        }),
      });
    });
  });

  it("keeps the optional description collapsed and retains its value across toggles", async () => {
    renderSubmitRun("experiment");

    const toggle = await screen.findByRole("button", {
      name: "Description (optional)",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("Description")).toBeNull();

    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Compare authentication approaches" },
    });
    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("Description")).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(
      (screen.getByLabelText("Description") as HTMLTextAreaElement).value,
    ).toBe("Compare authentication approaches");
  });

  it("infers an empty Experiment until a scenario is entered", async () => {
    renderSubmitRun("experiment");

    expect(
      await screen.findByRole("button", { name: /Create empty experiment/ }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Tags")).toBeNull();
    expect(screen.queryByText("Gate pipeline")).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Toggle advanced options" }),
    ).toBeNull();
    expect(screen.getAllByText(/No scenario selected/).length).toBeGreaterThan(
      0,
    );

    fireEvent.change(screen.getByLabelText(/Task/), {
      target: { value: "Implement the benchmark task" },
    });

    expect(screen.getByText("Gate pipeline")).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Toggle advanced options" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Create experiment with 5 runs/,
      }),
    ).toBeTruthy();
  });

  it("submits an explicit empty payload when no scenario is selected", async () => {
    renderSubmitRun("experiment");

    fireEvent.change(screen.getByLabelText("Name *"), {
      target: { value: "Reserved benchmark" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Create empty experiment/ }),
    );

    await waitFor(() => {
      expect(api.createExperiment).toHaveBeenCalledWith({
        metadata: { name: "Reserved benchmark" },
        reportTemplateIds: [],
        empty: true,
      });
    });
  });
});
