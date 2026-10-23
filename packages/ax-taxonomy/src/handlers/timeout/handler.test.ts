// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  evaluate,
  parseScopeAtif,
  type ScopeAtif,
} from "taxonomy-engine";
import {
  loadAgentBehaviorTaxonomy,
} from "../../index.js";

async function taxonomy() {
  return loadAgentBehaviorTaxonomy();
}

/** Creates one minimal call whose namespaced evidence can be varied per test. */
function input(
  evidence: Record<string, unknown>,
  trajectoryState: "complete" | "partial" | "unknown" = "complete",
): ScopeAtif {
  return parseScopeAtif({
    schema_version: "ATIF-v1.7",
    session_id: "timeout-test",
    agent: { name: "fixture" },
    steps: [
      { step_id: 1, source: "user", message: "Query the service." },
      {
        step_id: 2,
        source: "agent",
        message: "Calling query.",
        tool_calls: [{
          tool_call_id: "query-1",
          function_name: "query",
          arguments: {},
          extra: { scope: evidence },
        }],
      },
    ],
    extra: {
      scope: {
        schema_version: "scope.atif-extension.v1",
        trajectory_state: trajectoryState,
        available_sources: [],
      },
    },
  });
}

/** Evaluates only the YAML-backed built-in Timeout element. */
async function result(
  evidence: Record<string, unknown>,
  trajectoryState: "complete" | "partial" | "unknown" = "complete",
) {
  const loaded = await taxonomy();
  return (await evaluate(
    { atif: input(evidence, trajectoryState), taxonomy: loaded },
    ["beh-timeout"],
  ))[0].result as Record<string, unknown>;
}

describe("scope/timeout-v1", () => {
  it.each([
    ["explicit timeout", { outcome: "timeout" }, "complete", "completed", true],
    ["explicit timeout on partial run", { outcome: "timeout" }, "partial", "completed", true],
    ["policy boundary", { outcome: "abandoned", duration_ms: 30000 }, "complete", "completed", true],
    ["below boundary", { outcome: "abandoned", duration_ms: 29999 }, "complete", "completed", false],
    ["stalled", { outcome: "pending", duration_ms: 30001 }, "complete", "completed", true],
    ["normal completion", { outcome: "completed", duration_ms: 20, progress_interrupted: false }, "complete", "completed", false],
    ["slow without interruption", { outcome: "completed", duration_ms: 50000, progress_interrupted: false }, "complete", "completed", false],
    ["slow with interruption", { outcome: "completed", duration_ms: 50000, progress_interrupted: true }, "complete", "completed", true],
    ["slow missing interruption evidence", { outcome: "completed", duration_ms: 50000 }, "complete", "indeterminate", undefined],
    ["quick non-timeout error", { outcome: "error", duration_ms: 10 }, "complete", "completed", false],
    ["missing timing", { outcome: "completed" }, "complete", "indeterminate", undefined],
    ["contradictory timing", {
      outcome: "timeout",
      duration_ms: 10,
      started_at: "2026-01-01T00:00:00Z",
      ended_at: "2026-01-01T00:00:02Z",
    }, "complete", "indeterminate", undefined],
    ["reversed timing", {
      outcome: "timeout",
      started_at: "2026-01-01T00:00:02Z",
      ended_at: "2026-01-01T00:00:00Z",
    }, "complete", "indeterminate", undefined],
    ["timestamp duration", {
      outcome: "abandoned",
      started_at: "2026-01-01T00:00:00Z",
      ended_at: "2026-01-01T00:00:30Z",
    }, "complete", "completed", true],
  ] as const)("%s", async (_name, evidence, state, expectedState, observed) => {
    const actual = await result(evidence, state);
    expect(actual.state).toBe(expectedState);
    if (observed !== undefined) expect(actual.observed).toBe(observed);
  });

  it("keeps a proven timeout when another call is incomplete", async () => {
    const loaded = await taxonomy();
    const atif = input({ outcome: "timeout" }, "partial");
    atif.steps[1].tool_calls!.push({
      tool_call_id: "unknown",
      function_name: "other",
      arguments: {},
    });
    const evaluation = (await evaluate(
      { atif, taxonomy: loaded },
      ["beh-timeout"],
    ))[0];
    expect(evaluation.result).toMatchObject({
      state: "completed",
      observed: true,
    });
  });
});
