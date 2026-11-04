// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { parseTaxonomyRunResult } from "./taxonomy-result";

const result = {
  run: {
    id: "run-1",
    scenario: { id: "scenario-1", label: "Scenario" },
    profile: { id: "profile-1", label: "Profile" },
  },
  results: [
    {
      schema_version: "scope/taxonomy-evaluation/v1",
      status: "succeeded",
      taxonomy: {
        id: "ax-taxonomy",
        version: "1.0.0",
        digest: "a".repeat(64),
      },
      element: { id: "element-1", label: "Element" },
      implementation: {
        type: "deterministic",
        handler: "element-1",
        attempts: [{ attempt: 1, kind: "initial", outcome: "succeeded" }],
      },
      input: {
        normalization: "scope/taxonome-normalized-atif/v1",
        sha256: "b".repeat(64),
      },
      result: { state: "completed", observed: false },
    },
  ],
};

describe("parseTaxonomyRunResult", () => {
  it("parses the typed result envelope", () => {
    expect(parseTaxonomyRunResult(result)).toMatchObject({
      run: { id: "run-1" },
      results: [{ status: "succeeded", element: { id: "element-1" } }],
    });
  });

  it.each([
    null,
    { ...result, results: null },
    {
      ...result,
      results: [{ ...result.results[0], status: "unexpected" }],
    },
    {
      ...result,
      results: [{ ...result.results[0], element: {} }],
    },
  ])("rejects malformed result data %#", (value) => {
    expect(() => parseTaxonomyRunResult(value)).toThrow();
  });
});
