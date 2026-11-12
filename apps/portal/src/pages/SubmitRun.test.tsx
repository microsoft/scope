// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  },
}));

vi.mock("@/hooks/useVisibleGates", () => ({ useVisibleGates: () => [] }));
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
    activeModelIds: [],
    capabilitiesLoaded: true,
  }),
  useReasoningEffort: () => ({
    supportedEfforts: [],
    workerEffortWarning: undefined,
  }),
}));
vi.mock("@/components/TaskPromptPicker", () => ({ TaskPromptPicker: () => null }));
vi.mock("@/components/CriteriaPicker", () => ({
  CriteriaPicker: ({ trailingAction, inputId, selected }: {
    trailingAction?: ReactNode;
    inputId?: string;
    selected: string[];
  }) => <div data-testid={inputId}>{selected.join(", ")}{trailingAction}</div>,
}));
vi.mock("@/components/CreateCriterionDialog", () => ({
  CreateCriterionDialog: ({
    open, mode, onCreated, defaultGates, lockedGates,
  }: ComponentProps<typeof CreateCriterionDialog>) => open ? (
    <div role="dialog">
      <span>{mode ?? "criteria"}</span>
      <span data-testid="default-gates">{defaultGates?.join(",")}</span>
      <span data-testid="locked-gates">{lockedGates?.join(",")}</span>
      <button onClick={() => onCreated("new_observation")}>Complete creation</button>
    </div>
  ) : null,
}));
vi.mock("@/components/SkillPicker", () => ({ SkillPicker: () => null }));
vi.mock("@/components/CodebasePicker", () => ({ CodebasePicker: () => null }));
vi.mock("@/components/ResourcePicker", () => ({ ResourcePicker: () => null }));
vi.mock("@/components/ExtensionPicker", () => ({ ExtensionPicker: () => null }));
vi.mock("@/components/ProfilePicker", () => ({ ProfilePicker: () => null }));
vi.mock("@/components/ProfileCreateForm", () => ({ ProfileCreateForm: () => null }));
vi.mock("@/components/AgentBadge", () => ({ AgentBadge: () => null }));

import { SubmitRun } from "./SubmitRun";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderRunForm() {
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

describe("SubmitRun Observation creation", () => {
  it("opens the specialized shared wizard and selects the created observation only", async () => {
    renderRunForm();

    fireEvent.click(await screen.findByRole("button", { name: "New Observation" }));
    expect(screen.getByText("observation", { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Complete creation" }));
    expect(screen.getByTestId("observations").textContent).toContain("new_observation");
    expect(screen.getByTestId("criteria").textContent).not.toContain("new_observation");
  });

  it("keeps requirements creation generic with locked Select gates", async () => {
    renderRunForm();

    fireEvent.click(within(screen.getByTestId("criteria")).getByRole("button", { name: "New…" }));
    expect(screen.getByText("criteria", { exact: true })).toBeTruthy();
    expect(screen.getByTestId("default-gates").textContent).toBe("select");
    expect(screen.getByTestId("locked-gates").textContent).toBe("select");
  });
});
