// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ResourceBindingSpec, ResourceDocument, ResourceRevisionDocument } from "@/types";

const resources: ResourceDocument[] = [
  {
    _id: "resource-1",
    projectId: "project-1",
    slug: "github-sim",
    name: "GitHub simulator",
    revisionCounter: 1,
    latestRevisionId: "revision-1",
    latestRevisionNumber: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

const revisions: ResourceRevisionDocument[] = [
  {
    _id: "revision-1",
    resourceId: "resource-1",
    projectId: "project-1",
    slug: "github-sim",
    revisionNumber: 1,
    ref: "github-sim@r1",
    setup: { sh: "echo ok" },
    exports: ["SIMULATOR_URL"],
    parameters: [
      {
        name: "REPO",
        description: "Repository to simulate",
        required: true,
      },
      {
        name: "SCENARIO",
        description: "Scenario name",
        required: false,
        default: "default-scenario",
      },
    ],
    contentSha256: "sha",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

vi.mock("@/lib/api", () => ({
  api: {
    listResources: vi.fn(async () => resources),
    listResourceRevisions: vi.fn(async () => revisions),
  },
}));

import { ResourcePicker } from "./ResourcePicker";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPicker(props: {
  selected: ResourceBindingSpec[];
  profileBindings?: ResourceBindingSpec[];
  onChange?: (bindings: ResourceBindingSpec[]) => void;
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ResourcePicker
        selected={props.selected}
        profileBindings={props.profileBindings}
        onChange={props.onChange ?? vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("ResourcePicker parameter bindings", () => {
  it("locks parameter values controlled by the selected profile", async () => {
    const selected = [{ ref: "github-sim@r1", params: { REPO: "microsoft/scope" } }];
    const onChange = vi.fn();

    renderPicker({
      selected,
      profileBindings: selected,
      onChange,
    });

    const repoInput = await screen.findByLabelText("REPO") as HTMLInputElement;
    expect(repoInput.disabled).toBe(true);
    expect(repoInput.value).toBe("microsoft/scope");
    expect(screen.getByText("Profile controls this value.")).toBeTruthy();

    const scenarioInput = screen.getByLabelText("SCENARIO") as HTMLInputElement;
    expect(scenarioInput.disabled).toBe(false);
    expect(scenarioInput.value).toBe("default-scenario");

    fireEvent.change(scenarioInput, { target: { value: "custom-scenario" } });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange).toHaveBeenLastCalledWith([
      {
        ref: "github-sim@r1",
        params: {
          REPO: "microsoft/scope",
          SCENARIO: "custom-scenario",
        },
      },
    ]);
  });
});
