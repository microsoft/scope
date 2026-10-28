// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, cleanup, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCriteriaWizard } from "./useCriteriaWizard";
import { api } from "@/lib/api";
import { toast } from "sonner";

vi.mock("@/lib/api", () => ({
  api: {
    listCriteria: vi.fn().mockResolvedValue([]),
    generateCriteriaPrompt: vi.fn().mockResolvedValue({
      prompt: "generated",
      suggestedId: "",
      suggestedParents: [],
      suggestedChildren: [],
    }),
    createCriterion: vi.fn(),
    getCriterion: vi.fn(),
    updateCriterion: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const listCriteria = vi.mocked(api.listCriteria);
const generateCriteriaPrompt = vi.mocked(api.generateCriteriaPrompt);
const createCriterion = vi.mocked(api.createCriterion);
const getCriterion = vi.mocked(api.getCriterion);
const updateCriterion = vi.mocked(api.updateCriterion);
const toastWarning = vi.mocked(toast.warning);

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  listCriteria.mockResolvedValue([]);
});

describe("useCriteriaWizard initial gates", () => {
  it("defaults gate compatibility to ['select'] when initialGates is omitted", () => {
    const { result } = renderHook(
      () => useCriteriaWizard({ onSuccess: () => {} }),
      { wrapper },
    );
    expect(result.current.gates).toEqual(["select"]);
  });

  it("honours initialGates when provided", () => {
    const { result } = renderHook(
      () => useCriteriaWizard({ initialGates: ["build"], onSuccess: () => {} }),
      { wrapper },
    );
    expect(result.current.gates).toEqual(["build"]);
  });

  it("surfaces lockedGates in wizard state", () => {
    const { result } = renderHook(
      () => useCriteriaWizard({ lockedGates: ["build"], onSuccess: () => {} }),
      { wrapper },
    );
    expect(result.current.lockedGates).toEqual(["build"]);
  });

  it("leaves lockedGates undefined when not provided", () => {
    const { result } = renderHook(
      () => useCriteriaWizard({ onSuccess: () => {} }),
      { wrapper },
    );
    expect(result.current.lockedGates).toBeUndefined();
  });
});

describe("useCriteriaWizard generation passes target gates", () => {
  afterEach(() => {
    generateCriteriaPrompt.mockResolvedValue({
      prompt: "generated",
      suggestedId: "",
      suggestedParents: [],
      suggestedChildren: [],
    });
  });

  it("sends the current gates on initial generation (handleContinue)", async () => {
    const { result } = renderHook(
      () => useCriteriaWizard({ initialGates: ["build"], onSuccess: () => {} }),
      { wrapper },
    );

    act(() => result.current.handleBehaviorChange("detect docker"));
    act(() => result.current.handleContinue());

    await waitFor(() =>
      expect(generateCriteriaPrompt).toHaveBeenCalledWith("detect docker", undefined, ["build"]),
    );
  });

  it("sends gates chosen in Step 1 (setGates before handleContinue)", async () => {
    const { result } = renderHook(
      () => useCriteriaWizard({ onSuccess: () => {} }),
      { wrapper },
    );

    act(() => result.current.handleBehaviorChange("detect docker"));
    act(() => result.current.setGates(["select", "build", "test"]));
    act(() => result.current.handleContinue());

    await waitFor(() =>
      expect(generateCriteriaPrompt).toHaveBeenCalledWith("detect docker", undefined, [
        "select",
        "build",
        "test",
      ]),
    );
  });

  it("sends the Step-2 gate choices on regenerate (handleRegenerate)", async () => {
    const { result } = renderHook(
      () => useCriteriaWizard({ onSuccess: () => {} }),
      { wrapper },
    );

    act(() => result.current.handleBehaviorChange("detect docker"));
    act(() => result.current.setGates(["select", "build", "test"]));
    act(() => result.current.handleRegenerate());

    await waitFor(() =>
      expect(generateCriteriaPrompt).toHaveBeenCalledWith("detect docker", undefined, [
        "select",
        "build",
        "test",
      ]),
    );
  });
});

describe("useCriteriaWizard preserves the id across generation", () => {
  afterEach(() => {
    generateCriteriaPrompt.mockResolvedValue({
      prompt: "generated",
      suggestedId: "",
      suggestedParents: [],
      suggestedChildren: [],
    });
  });

  it("does not overwrite the slugified id with the AI's suggestedId", async () => {
    generateCriteriaPrompt.mockResolvedValue({
      prompt: "generated",
      suggestedId: "ai_invented_id",
      suggestedParents: [],
      suggestedChildren: [],
    });

    const { result } = renderHook(() => useCriteriaWizard({ onSuccess: () => {} }), { wrapper });

    act(() => result.current.handleBehaviorChange("Project builds"));
    expect(result.current.id).toBe("project_builds");

    act(() => result.current.handleContinue());

    // Wait until the generated prompt lands (generation resolved).
    await waitFor(() => expect(result.current.aiGenerated).toBe(true));

    // The id must remain the slugified behavior name, not the AI's suggestion.
    expect(result.current.id).toBe("project_builds");
  });
});

describe("useCriteriaWizard gate-compatibility pruning", () => {
  it("prunes a pre-selected parent incompatible with the chosen gates", async () => {
    // Parent applies only to 'select'; the new criterion applies to 'build', so the
    // parent does not cover every gate of its dependent → must be dropped.
    listCriteria.mockResolvedValue([
      { id: "parent_select", prompt: "p", gates: ["select"], createdAt: "" },
    ]);
    const { result } = renderHook(
      () =>
        useCriteriaWizard({
          initialDependsOn: ["parent_select"],
          initialGates: ["build"],
          onSuccess: () => {},
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.dependsOn).toEqual([]));
  });

  it("keeps a pre-selected parent compatible with the chosen gates", async () => {
    // Parent covers both 'build' and 'test' → compatible with a 'build' dependent.
    listCriteria.mockResolvedValue([
      { id: "parent_wide", prompt: "p", gates: ["build", "test"], createdAt: "" },
      { id: "parent_universal", prompt: "p", createdAt: "" },
    ]);
    const { result } = renderHook(
      () =>
        useCriteriaWizard({
          initialDependsOn: ["parent_wide", "parent_universal"],
          initialGates: ["build"],
          onSuccess: () => {},
        }),
      { wrapper },
    );
    // Allow the criteria query to resolve, then assert both parents survive.
    await waitFor(() => expect(listCriteria).toHaveBeenCalled());
    await Promise.resolve();
    expect(result.current.dependsOn).toEqual(["parent_wide", "parent_universal"]);
  });

  it("prunes a selected child when gates narrow to be incompatible", async () => {
    // Child applies to 'select'. While the criterion covers 'select' the child is a
    // valid subset; narrowing the criterion to 'build' alone makes it incompatible.
    listCriteria.mockResolvedValue([
      { id: "child_select", prompt: "c", gates: ["select"], createdAt: "" },
    ]);
    const { result } = renderHook(
      () => useCriteriaWizard({ initialGates: ["select"], onSuccess: () => {} }),
      { wrapper },
    );
    await waitFor(() => expect(listCriteria).toHaveBeenCalled());
    act(() => result.current.setAcceptedChildren(["child_select"]));
    expect(result.current.acceptedChildren).toEqual(["child_select"]);

    act(() => result.current.setGates(["build"]));
    await waitFor(() => expect(result.current.acceptedChildren).toEqual([]));
  });
});

describe("useCriteriaWizard candidate availability flags", () => {
  it("reports no compatible parents or children for a tool gate against a select-only library", async () => {
    listCriteria.mockResolvedValue([
      { id: "a_select", prompt: "p", gates: ["select"], createdAt: "" },
    ]);
    const { result } = renderHook(
      () => useCriteriaWizard({ initialGates: ["build"], onSuccess: () => {} }),
      { wrapper },
    );
    await waitFor(() => expect(listCriteria).toHaveBeenCalled());
    await waitFor(() => {
      expect(result.current.hasCompatibleParentCandidates).toBe(false);
      expect(result.current.hasCompatibleChildCandidates).toBe(false);
    });
  });

  it("reports compatible parents and children for a select criterion against a select library", async () => {
    listCriteria.mockResolvedValue([
      { id: "a_select", prompt: "p", gates: ["select"], createdAt: "" },
    ]);
    const { result } = renderHook(
      () => useCriteriaWizard({ initialGates: ["select"], onSuccess: () => {} }),
      { wrapper },
    );
    await waitFor(() => expect(listCriteria).toHaveBeenCalled());
    await waitFor(() => {
      expect(result.current.hasCompatibleParentCandidates).toBe(true);
      expect(result.current.hasCompatibleChildCandidates).toBe(true);
    });
  });
});

describe("useCriteriaWizard surfaces child-link failures", () => {
  it("warns (but still succeeds) when an accepted child cannot be linked", async () => {
    listCriteria.mockResolvedValue([
      { id: "child_ok", prompt: "c", gates: ["select"], createdAt: "" },
    ]);
    createCriterion.mockResolvedValue({ id: "new_crit", prompt: "p", createdAt: "" });
    getCriterion.mockResolvedValue({
      id: "child_ok",
      prompt: "c",
      dependsOn: [],
      gates: ["select"],
      createdAt: "",
      dependents: [],
    });

    updateCriterion.mockRejectedValue(new Error("would create a cycle"));

    const onSuccess = vi.fn();
    const { result } = renderHook(
      () => useCriteriaWizard({ initialGates: ["select"], onSuccess }),
      { wrapper },
    );
    await waitFor(() => expect(listCriteria).toHaveBeenCalled());
    act(() => result.current.setAcceptedChildren(["child_ok"]));

    await act(async () => {
      await result.current.createMutation.mutateAsync({
        id: "new_crit",
        prompt: "p",
        gates: ["select"],
      });
    });

    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1));
    expect(toastWarning.mock.calls[0][0]).toContain("child_ok");
    expect(onSuccess).toHaveBeenCalledWith("new_crit");
  });

  it("does not warn when every accepted child links successfully", async () => {
    listCriteria.mockResolvedValue([
      { id: "child_ok", prompt: "c", gates: ["select"], createdAt: "" },
    ]);
    createCriterion.mockResolvedValue({ id: "new_crit", prompt: "p", createdAt: "" });
    getCriterion.mockResolvedValue({
      id: "child_ok",
      prompt: "c",
      dependsOn: [],
      gates: ["select"],
      createdAt: "",
      dependents: [],
    });
    updateCriterion.mockResolvedValue({ id: "child_ok", prompt: "c", createdAt: "" });

    const onSuccess = vi.fn();
    const { result } = renderHook(
      () => useCriteriaWizard({ initialGates: ["select"], onSuccess }),
      { wrapper },
    );
    await waitFor(() => expect(listCriteria).toHaveBeenCalled());
    act(() => result.current.setAcceptedChildren(["child_ok"]));

    await act(async () => {
      await result.current.createMutation.mutateAsync({
        id: "new_crit",
        prompt: "p",
        gates: ["select"],
      });
    });

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("new_crit"));
    expect(updateCriterion).toHaveBeenCalledWith("child_ok", { dependsOn: ["new_crit"] });
    expect(toastWarning).not.toHaveBeenCalled();
  });
});

describe("useCriteriaWizard Observation creation", () => {
  afterEach(() => {
    generateCriteriaPrompt.mockResolvedValue({
      prompt: "generated",
      suggestedId: "",
      suggestedParents: [],
      suggestedChildren: [],
    });
  });

  it.each(["run", "iteration"] as const)("preserves the %s subject without gate fields", async (subject) => {
    createCriterion.mockResolvedValue({ id: "has_tests", prompt: "p", createdAt: "" });
    const { result } = renderHook(
      () => useCriteriaWizard({
        initialKind: "observation",
        entityLabel: "Observation",
        onSuccess: vi.fn(),
      }),
      { wrapper },
    );
    act(() => {
      result.current.handleBehaviorChange("Has tests");
      result.current.setPrompt("p");
      result.current.setSubject(subject);
    });
    act(() => result.current.handleCreate());

    await waitFor(() => expect(createCriterion.mock.calls[0]?.[0]).toEqual({
      id: "has_tests",
      prompt: "p",
      dependsOn: undefined,
      kind: "observation",
      subject,
    }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Observation "has_tests" created'));
    act(() => result.current.reset());
    expect(result.current.kind).toBe("observation");
    expect(result.current.subject).toBe("run");
    expect(result.current.step).toBe(1);
  });

  it("retains the existing AI subject suggestion and manual override", async () => {
    generateCriteriaPrompt.mockResolvedValue({
      prompt: "generated",
      suggestedId: "",
      suggestedParents: [],
      suggestedChildren: [],
      suggestedSubject: "iteration",
    });
    const { result } = renderHook(
      () => useCriteriaWizard({ initialKind: "observation", onSuccess: vi.fn() }),
      { wrapper },
    );
    act(() => result.current.handleBehaviorChange("Has tests"));
    act(() => result.current.handleContinue());
    await waitFor(() => expect(result.current.subject).toBe("iteration"));
    expect(generateCriteriaPrompt).toHaveBeenCalledWith("Has tests", undefined, undefined);
    act(() => result.current.setSubject("run"));
    expect(result.current.subject).toBe("run");
  });

  it("uses Observation copy when reporting child-link failures", async () => {
    createCriterion.mockResolvedValue({ id: "new_observation", prompt: "p", createdAt: "" });
    getCriterion.mockResolvedValue({
      id: "child_observation", kind: "observation", prompt: "c", createdAt: "", dependents: [],
    });
    updateCriterion.mockRejectedValue(new Error("would create a cycle"));
    const onSuccess = vi.fn();
    const { result } = renderHook(
      () => useCriteriaWizard({ initialKind: "observation", entityLabel: "Observation", onSuccess }),
      { wrapper },
    );
    act(() => result.current.setAcceptedChildren(["child_observation"]));
    await act(async () => {
      await result.current.createMutation.mutateAsync({
        id: "new_observation", prompt: "p", kind: "observation", subject: "run",
      });
    });
    expect(toastWarning).toHaveBeenCalledWith(
      'Created "new_observation", but couldn\'t link 1 child observation (child_observation). Add the dependency manually.',
    );
    expect(onSuccess).toHaveBeenCalledWith("new_observation");
  });
});
