// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { TaxonomyRunResultResponseSchema } from "shared";
import { taxonomyRunResultSchema } from "./readout-v2";

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

describe("Taxonome result response contract", () => {
  it("accepts engine-valid result envelopes in the shared API schema", () => {
    expect(taxonomyRunResultSchema.safeParse(result).success).toBe(true);
    expect(TaxonomyRunResultResponseSchema.safeParse(result).success).toBe(true);
  });

  it("rejects malformed result envelopes in both schemas", () => {
    const invalid = {
      ...result,
      results: [{ ...result.results[0], schema_version: "unexpected" }],
    };
    expect(taxonomyRunResultSchema.safeParse(invalid).success).toBe(false);
    expect(TaxonomyRunResultResponseSchema.safeParse(invalid).success).toBe(
      false,
    );
  });
});
