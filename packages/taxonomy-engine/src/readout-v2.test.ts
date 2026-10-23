// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { buildReadoutV2, readoutMarkdownV2 } from "./readout-v2.js";

const taxonomy = {
  id: "behavior",
  version: "1.0.0",
  digest: "digest-1",
};

/** Wraps dynamic element metadata/result in the v2 evaluation envelope. */
function evaluation(
  element: { id: string; label: string; category_id?: string },
  result: unknown,
) {
  return {
    schema_version: "scope/taxonomy-evaluation/v1",
    taxonomy,
    element,
    implementation: { type: "deterministic" },
    result,
  };
}

const runContext = {
  scenario: { id: "scenario", label: "Scenario" },
  profile: { id: "profile", label: "Profile" },
};

describe("v2 readout", () => {
  it("counts distinct runs separately from occurrences and preserves evidence", () => {
    const timeout = {
      id: "custom-timeout",
      label: "Custom Timeout",
      category_id: "invocation",
    };
    const source = {
      id: "account",
      label: "account/query",
      surface_id: "surface-mcp",
    };
    const report = buildReadoutV2([
      {
        run: { id: "one", ...runContext },
        results: [evaluation(timeout, {
          state: "completed",
          observed: true,
          occurrences: [
            { source, related_turns: [2], tool_call_id: "a" },
            { source, related_turns: [3], tool_call_id: "b" },
          ],
        })],
      },
      {
        run: { id: "two", ...runContext },
        results: [evaluation(timeout, {
          state: "completed",
          observed: true,
          occurrences: [
            { source, related_turns: [4], tool_call_id: "c" },
          ],
        })],
      },
      {
        run: { id: "three", ...runContext },
        results: [],
      },
    ]);

    const behavior = report.groups[0].behaviors[0];
    expect(behavior).toMatchObject({
      element_id: "custom-timeout",
      label: "Custom Timeout",
      category_id: "invocation",
      coverage: {
        total: 3,
        assessed: 2,
        unknown: 1,
        missing: 1,
      },
      distinct_runs: 2,
      occurrences: 3,
      sources: [{
        source,
        distinct_runs: 2,
        occurrences: 3,
      }],
    });
    expect(readoutMarkdownV2(report)).toContain('"tool_call_id": "c"');
  });

  it("rejects duplicate runs, inconsistent taxonomies, and explicit digest mismatches", () => {
    const element = { id: "x", label: "X" };
    const run = {
      run: { id: "one", ...runContext },
      results: [evaluation(element, { state: "completed", observed: false })],
    };
    expect(() => buildReadoutV2([run, run])).toThrow("Duplicate readout run");
    expect(() => buildReadoutV2([
      run,
      {
        run: { id: "two", ...runContext },
        results: [{
          ...evaluation(element, { state: "completed", observed: false }),
          taxonomy: { ...taxonomy, digest: "other" },
        }],
      },
    ])).toThrow("different taxonomy digests");
    expect(() => buildReadoutV2([run], {
      digest: "expected",
    } as never)).toThrow("does not match");
  });
});
