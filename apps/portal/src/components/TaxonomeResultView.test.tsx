// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TaxonomyRunResult } from "@/lib/taxonomy-result";
import { TaxonomeResultView } from "./TaxonomeResultView";

const result: TaxonomyRunResult = {
  run: {
    id: "run-1",
    scenario: { id: "request-1", label: "Scenario", task: "Task" },
    profile: { id: "profile-1", label: "Profile" },
  },
  results: [
    {
      status: "succeeded",
      taxonomy: { id: "ax-taxonomy", version: "1.0.0", digest: "a".repeat(64) },
      element: { id: "beh-test", label: "Test behavior" },
      implementation: {
        type: "deterministic",
        handler: "test",
        attempts: [{ attempt: 1, kind: "initial", outcome: "succeeded" }],
      },
      input: { sha256: "b".repeat(64) },
      result: {
        state: "completed",
        observed: true,
        occurrences: [{ evidence: [{ role: "action", path: "$.events[0]" }] }],
      },
    },
  ],
};

describe("TaxonomeResultView", () => {
  afterEach(cleanup);

  it("renders typed element outcomes and identities", () => {
    render(<TaxonomeResultView result={result} />);
    expect(screen.getByText("ax-taxonomy")).toBeTruthy();
    expect(screen.getByText("Test behavior")).toBeTruthy();
    expect(screen.getByText(/Observed/)).toBeTruthy();
    expect(screen.getByText("$.events[0]")).toBeTruthy();
  });

  it("renders explicit unavailable state", () => {
    render(<TaxonomeResultView error="Artifact integrity check failed" />);
    expect(screen.getByText("Taxonome result unavailable")).toBeTruthy();
    expect(screen.getByText("Artifact integrity check failed")).toBeTruthy();
  });
});
