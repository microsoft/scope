// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { TaskPrompt } from "@/types";

const apiMocks = vi.hoisted(() => ({
  listAgents: vi.fn(async () => []),
  listAgentVersions: vi.fn(async () => []),
  listMcpServers: vi.fn(async () => []),
  listProfiles: vi.fn(async () => []),
  listRuns: vi.fn(async () => ({ data: [] })),
  listTaskPrompts: vi.fn(async () => ({ items: [] as TaskPrompt[], total: 0 })),
  submitRun: vi.fn(),
  createProfile: vi.fn(),
  generateTaskPrompt: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMocks }));

vi.mock("@/components/AdvancedModeToggle", () => ({
  AdvancedModeToggle: () => <div data-testid="advanced-mode-toggle" />,
}));

vi.mock("@/components/CriteriaPicker", () => ({
  CriteriaPicker: () => <div data-testid="criteria-picker" />,
}));

vi.mock("@/components/CreateCriterionDialog", () => ({
  CreateCriterionDialog: () => null,
}));

vi.mock("@/components/HelpTooltip", () => ({
  HelpTooltip: () => null,
}));

vi.mock("@/components/ReasoningEffortSelect", () => ({
  ModelSelectItems: () => null,
  ReasoningEffortSelect: () => null,
  useModelCapabilities: () => ({
    capabilitiesMap: new Map(),
    activeModelIds: [],
  }),
  useReasoningEffort: () => ({
    supportedEfforts: [],
    workerEffortWarning: false,
  }),
}));

vi.mock("@/hooks/useCommandEnter", () => ({
  createCommandEnterKeyDown: () => () => undefined,
  isMac: false,
  useCommandEnter: () => undefined,
}));

vi.mock("@/hooks/useVisibleGates", () => ({
  useVisibleGates: () => ["select"],
}));

vi.mock("@/components/ProfileCreateForm", () => ({
  ProfileCreateForm: () => <div data-testid="profile-create-form" />,
}));

vi.mock("@/components/ProfilePicker", () => ({
  ProfilePicker: () => <div data-testid="profile-picker" />,
}));

vi.mock("@/components/SkillPicker", () => ({
  SkillPicker: () => <div data-testid="skill-picker" />,
}));

vi.mock("@/components/CodebasePicker", () => ({
  CodebasePicker: () => <div data-testid="codebase-picker" />,
}));

vi.mock("@/components/ExtensionPicker", () => ({
  ExtensionPicker: () => <div data-testid="extension-picker" />,
}));

import { SubmitRun } from "./SubmitRun";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSubmitRun() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SubmitRun />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SubmitRun task prompt picker", () => {
  it("scopes the Task prompt-library query to Requirements prompts", async () => {
    apiMocks.listTaskPrompts.mockResolvedValue({
      items: [
        {
          _id: "select-prompt",
          text: "Build a REST API with tests.",
          type: "select",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      total: 1,
    });

    renderSubmitRun();

    fireEvent.focus(screen.getByPlaceholderText(/Search Requirements prompts/i));

    await waitFor(() => {
      expect(apiMocks.listTaskPrompts).toHaveBeenCalledWith({
        search: undefined,
        limit: 8,
        type: "select",
      });
    });
  });
});
