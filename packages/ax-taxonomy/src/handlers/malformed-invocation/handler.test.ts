// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { evaluate, parseScopeAtif } from "taxonomy-engine";
import { loadAgentBehaviorTaxonomy } from "../../index.js";

/** Builds one trajectory with optional calls and validation evidence. */
function input(
  calls: unknown[],
  trajectoryState: "complete" | "partial" | "unknown" = "complete",
) {
  return parseScopeAtif({
    schema_version: "ATIF-v1.7",
    session_id: "malformed-test",
    agent: { name: "fixture", version: "1.0.0" },
    steps: [
      { step_id: 1, source: "user", message: "Query the database." },
      {
        step_id: 2,
        source: "agent",
        message: "Calling.",
        ...(calls.length ? { tool_calls: calls } : {}),
      },
    ],
    extra: {
      scope: {
        schema_version: "scope.atif-extension.v1",
        trajectory_state: trajectoryState,
        available_sources: [{
          id: "db",
          label: "db/query",
          surface_id: "surface-mcp",
        }],
      },
    },
  });
}

const call = (
  validation: unknown,
  extras: Record<string, unknown> = {},
) => ({
  tool_call_id: "call-1",
  function_name: "db/query",
  arguments: {},
  extra: {
    scope: {
      source_id: "db",
      ...(validation ? { input_validation: validation } : {}),
      ...extras,
    },
  },
});

/** Evaluates the catalog's Malformed Invocation element. */
async function result(
  calls: unknown[],
  trajectoryState: "complete" | "partial" | "unknown" = "complete",
) {
  const taxonomy = await loadAgentBehaviorTaxonomy();
  const evaluation = (await evaluate(
    { atif: input(calls, trajectoryState), taxonomy },
    ["beh-malformed-invocation"],
  ))[0];
  if (evaluation.status !== "succeeded") {
    throw new Error(evaluation.error.message);
  }
  return evaluation.result;
}

describe("scope/malformed-invocation-v1", () => {
  it("reports explicit invalid input with stable issue codes and paths", async () => {
    await expect(result([call({
      status: "invalid",
      issues: [{
        code: "invalid_type",
        path: "$.limit",
        message: "Expected number.",
      }],
    })], "partial")).resolves.toEqual({
      state: "completed",
      observed: true,
      occurrences: [{
        evidence: [
          { role: "call", path: "$.steps[1].tool_calls[0]" },
          {
            role: "issue",
            path: "$.steps[1].tool_calls[0].extra.scope.input_validation.issues[0]",
          },
        ],
      }],
    });
  });

  it.each([
    ["valid complete call", [call({ status: "valid" })], "complete", "completed", false],
    ["no calls on complete run", [], "complete", "completed", false],
    ["missing validation", [call(undefined)], "complete", "indeterminate", undefined],
    ["unknown validation", [call({ status: "unknown" })], "complete", "indeterminate", undefined],
    ["no calls on partial run", [], "partial", "indeterminate", undefined],
    ["outcome error alone", [call(undefined, { outcome: "error" })], "complete", "indeterminate", undefined],
  ] as const)(
    "%s",
    async (_name, calls, trajectoryState, state, observed) => {
      const actual = await result(
        [...calls],
        trajectoryState as "complete" | "partial" | "unknown",
      ) as Record<string, unknown>;
      expect(actual.state).toBe(state);
      if (observed !== undefined) expect(actual.observed).toBe(observed);
    },
  );
});
