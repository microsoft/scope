// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CriteriaWizardStep2 } from "./CriteriaWizardStep2";
import type { CriteriaWizardState } from "@/hooks/useCriteriaWizard";
import type { CriteriaDocument } from "@/types";

// The picker fetches the full criteria list via api.listCriteria.
const CRITERIA: CriteriaDocument[] = [
  { id: "crit_a", prompt: "criterion a" } as CriteriaDocument,
  { id: "crit_b", prompt: "criterion b" } as CriteriaDocument,
  { id: "crit_c", prompt: "criterion c" } as CriteriaDocument,
];

vi.mock("@/lib/api", () => ({
  api: {
    listCriteria: vi.fn(async () => CRITERIA),
  },
}));

afterEach(() => cleanup());

const noopMutation = { isPending: false, isError: false, error: null } as never;

/**
 * Render Step 2 with real CriteriaPickers backed by the mocked criteria list.
 * `dependsOn` (parents) and `acceptedChildren` (children) are real React state so
 * the cross-exclusion filters react to selection changes.
 */
function Harness({
  initialParents = [],
  initialChildren = [],
  parentCandidates = true,
  childCandidates = true,
  generationError,
}: {
  initialParents?: string[];
  initialChildren?: string[];
  parentCandidates?: boolean;
  childCandidates?: boolean;
  generationError?: Error;
}) {
  const [dependsOn, setDependsOn] = useState<string[]>(initialParents);
  const [acceptedChildren, setAcceptedChildren] = useState<string[]>(initialChildren);

  const wizard = {
    behavior: "do a thing",
    id: "new_crit",
    dependsOn,
    setDependsOn,
    // undefined gates = universal, so the gate-compat filter admits every
    // candidate and cross-exclusion is the only thing removing ids.
    gates: undefined,
    prompt: "p",
    setPrompt: () => {},
    aiGenerated: false,
    setAiGenerated: () => {},
    suggestedParents: [],
    suggestedChildren: [],
    acceptedChildren,
    setAcceptedChildren,
    hasCompatibleParentCandidates: parentCandidates,
    hasCompatibleChildCandidates: childCandidates,
    handleRegenerate: () => {},
    generateMutation: generationError
      ? { isPending: false, isError: true, error: generationError }
      : noopMutation,
    createMutation: noopMutation,
  } as unknown as CriteriaWizardState;

  return <CriteriaWizardStep2 wizard={wizard} />;
}

function renderStep2(props: Parameters<typeof Harness>[0]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
}

/** Text content of the currently-open picker dropdown (portal-rendered). */
function openDropdownText(): string {
  const portal = document.querySelector("[data-criteria-picker-portal]");
  return portal?.textContent ?? "";
}

function pickerInputs(): HTMLElement[] {
  // Parents picker renders first, Children second.
  return screen.getAllByPlaceholderText("Type to search criteria…");
}

describe("CriteriaWizardStep2 — parent/child cross-exclusion", () => {
  it("does not offer a parent-selected criterion in the Children picker", async () => {
    renderStep2({ initialParents: ["crit_a"] });
    // Wait for the picker's criteria query to resolve (skeleton → inputs).
    const inputs = await screen.findAllByPlaceholderText("Type to search criteria…");
    const childrenInput = inputs[1];

    fireEvent.focus(childrenInput);

    const text = openDropdownText();
    expect(text).not.toContain("crit_a"); // selected as a parent → excluded here
    expect(text).toContain("crit_b");
    expect(text).toContain("crit_c");
  });

  it("does not offer a child-selected criterion in the Parents picker", async () => {
    renderStep2({ initialChildren: ["crit_b"] });
    await screen.findAllByPlaceholderText("Type to search criteria…");
    const parentsInput = pickerInputs()[0];

    fireEvent.focus(parentsInput);

    const text = openDropdownText();
    expect(text).not.toContain("crit_b"); // selected as a child → excluded here
    expect(text).toContain("crit_a");
    expect(text).toContain("crit_c");
  });
});

describe("CriteriaWizardStep2 — honest empty-pool notes", () => {
  it("explains why no parents are available when no candidate is gate-compatible", async () => {
    renderStep2({ parentCandidates: false, childCandidates: true });
    await screen.findAllByPlaceholderText("Type to search criteria…");
    expect(
      screen.getByText(/no gate-compatible criteria available as parents/i),
    ).toBeTruthy();
    expect(
      screen.queryByText(/no gate-compatible criteria available as children/i),
    ).toBeNull();
  });

  it("explains why no children are available when no candidate is gate-compatible", async () => {
    renderStep2({ parentCandidates: true, childCandidates: false });
    await screen.findAllByPlaceholderText("Type to search criteria…");
    expect(
      screen.getByText(/no gate-compatible criteria available as children/i),
    ).toBeTruthy();
    expect(
      screen.queryByText(/no gate-compatible criteria available as parents/i),
    ).toBeNull();
  });

  it("shows no empty-pool note when candidates exist in both directions", async () => {
    renderStep2({ parentCandidates: true, childCandidates: true });
    await screen.findAllByPlaceholderText("Type to search criteria…");
    expect(
      screen.queryByText(/no gate-compatible criteria available as parents/i),
    ).toBeNull();
    expect(
      screen.queryByText(/no gate-compatible criteria available as children/i),
    ).toBeNull();
  });
});

describe("CriteriaWizardStep2 — generation errors", () => {
  it("shows the inference error returned by the API", async () => {
    renderStep2({
      generationError: new Error(
        "LLM request failed: Unsupported parameter: 'max_tokens'",
      ),
    });

    expect(
      await screen.findByText(
        /AI generation failed — LLM request failed: Unsupported parameter: 'max_tokens'/,
      ),
    ).toBeTruthy();
  });
});
