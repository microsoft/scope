// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { CreateCriterionDialog } from "./CreateCriterionDialog";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: {
    listCriteria: vi.fn(),
    generateCriteriaPrompt: vi.fn(),
    createCriterion: vi.fn(),
  },
}));

beforeEach(() => {
  vi.mocked(api.listCriteria).mockResolvedValue([]);
  vi.mocked(api.generateCriteriaPrompt).mockResolvedValue({
    prompt: "Record whether the codebase contains unit tests.",
    suggestedId: "ai_suggested_id",
    suggestedParents: [],
    suggestedChildren: [],
  });
  vi.mocked(api.createCriterion).mockImplementation(async (input) => ({
    ...input,
    createdAt: "",
  }));
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function renderDialog(props: Partial<ComponentProps<typeof CreateCriterionDialog>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const onCreated = vi.fn();
  const onOpenChange = vi.fn();

  render(
    <QueryClientProvider client={queryClient}>
      <CreateCriterionDialog
        open
        onOpenChange={onOpenChange}
        onCreated={onCreated}
        {...props}
      />
    </QueryClientProvider>,
  );

  return { onCreated, onOpenChange };
}

describe("CreateCriterionDialog modes", () => {
  it("keeps generic Criteria creation and locked gates unchanged by default", async () => {
    renderDialog({ defaultGates: ["build"], lockedGates: ["build"] });

    expect(screen.getByRole("heading", { name: "New Criteria" })).toBeTruthy();
    expect(screen.getByLabelText("Criteria kind")).toBeTruthy();
    expect(screen.getByText(/Gate criteria steer the agent/)).toBeTruthy();
    expect(screen.getByText(/Criteria ID/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/What behavior do you want to track/), {
      target: { value: "Has unit tests" },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /Continue/ }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    await screen.findByText("Criteria Prompt (AI Generated)");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(vi.mocked(api.createCriterion).mock.calls[0]?.[0]).toEqual({
      id: "has_unit_tests",
      prompt: "Record whether the codebase contains unit tests.",
      dependsOn: undefined,
      kind: "gate",
      gates: ["build"],
    }));
  });

  it("retains defaultKind without opting into specialized Observation copy", () => {
    renderDialog({ defaultKind: "observation" });

    expect(screen.getByRole("heading", { name: "New Criteria" })).toBeTruthy();
    expect(screen.getByLabelText("Criteria kind").textContent).toContain("Observation");
    expect(screen.getByLabelText("Evaluation subject")).toBeTruthy();
  });

  it("fixes the Observation kind and creates a run-subject observation without gates", async () => {
    const { onCreated, onOpenChange } = renderDialog({
      mode: "observation",
      defaultKind: "gate",
      defaultGates: ["build"],
    });

    expect(screen.getByRole("heading", { name: "New Observation" })).toBeTruthy();
    expect(screen.getByText(/Observation ID/)).toBeTruthy();
    expect(screen.getByText("Observation dimension")).toBeTruthy();
    expect(screen.getByLabelText("Evaluation subject").textContent).toContain("Whole run");
    expect(screen.queryByLabelText("Criteria kind")).toBeNull();
    expect(screen.queryByText(/Gate criteria steer the agent/)).toBeNull();
    expect(screen.queryByText("Gate compatibility")).toBeNull();

    fireEvent.change(screen.getByLabelText(/What behavior do you want to observe/), {
      target: { value: "Has unit tests" },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /Continue/ }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));

    await screen.findByText("Observation Prompt (AI Generated)");
    expect(screen.getByRole("heading", { name: "Review & Create Observation" })).toBeTruthy();
    expect(screen.getAllByPlaceholderText("Search observations…")).toHaveLength(2);
    expect(screen.queryByText(/Criteria Prompt/)).toBeNull();
    expect(screen.queryByText(/observation criteria/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create Observation" }));

    await waitFor(() => {
      expect(vi.mocked(api.createCriterion).mock.calls[0]?.[0]).toEqual({
        dependsOn: undefined,
        id: "has_unit_tests",
        prompt: "Record whether the codebase contains unit tests.",
        kind: "observation",
        subject: "run",
      });
      expect(onCreated).toHaveBeenCalledWith("has_unit_tests");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(api.generateCriteriaPrompt).toHaveBeenCalledWith("Has unit tests", undefined, undefined);
  });
});
