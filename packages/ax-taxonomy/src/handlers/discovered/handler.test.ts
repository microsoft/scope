// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { evaluate, parseScopeAtif } from "taxonomy-engine";
import { loadAgentBehaviorTaxonomy } from "../../index.js";

/** Builds ATIF with explicit discovery evidence and optional trajectory state. */
function input(options: {
  discoveries?: Array<{ source_id: string; extension_point: string }>;
  trajectoryState?: "complete" | "partial" | "unknown";
}) {
  return parseScopeAtif({
    schema_version: "ATIF-v1.7",
    session_id: "discovered-test",
    agent: { name: "fixture", version: "1.0.0" },
    steps: [{
      step_id: 1,
      source: "agent",
      message: "Discovery evidence.",
      ...(options.discoveries
        ? { extra: { scope: { discoveries: options.discoveries } } }
        : {}),
    }],
    extra: {
      scope: {
        schema_version: "scope.atif-extension.v1",
        trajectory_state: options.trajectoryState ?? "complete",
        available_sources: [{
          id: "db",
          label: "db/query",
          surface_id: "surface-mcp",
        }],
      },
    },
  });
}

describe("scope/discovered-v1", () => {
  it("deduplicates exact discovery events but preserves grounded identity", async () => {
    const taxonomy = await loadAgentBehaviorTaxonomy();
    const [evaluation] = await evaluate(
      {
        atif: input({
          trajectoryState: "partial",
          discoveries: [
            { source_id: "db", extension_point: "db/query" },
            { source_id: "db", extension_point: "db/query" },
          ],
        }),
        taxonomy,
      },
      ["beh-discovered"],
    );

    expect(evaluation.status).toBe("succeeded");
    if (evaluation.status !== "succeeded") return;
    expect(evaluation.result).toEqual({
      state: "completed",
      observed: true,
      occurrences: [{
        evidence: [{
          role: "discovery",
          path: "$.steps[0].extra.scope.discoveries[0]",
        }],
      }],
    });
  });

  it("preserves repeated discoveries recorded on distinct turns", async () => {
    const taxonomy = await loadAgentBehaviorTaxonomy();
    const atif = parseScopeAtif({
      schema_version: "ATIF-v1.7",
      session_id: "discovered-repeat",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [1, 2].map(stepId => ({
        step_id: stepId,
        source: "agent",
        message: `Discovery ${stepId}.`,
        extra: {
          scope: {
            discoveries: [{
              source_id: "db",
              extension_point: "db/query",
            }],
          },
        },
      })),
      extra: {
        scope: {
          schema_version: "scope.atif-extension.v1",
          trajectory_state: "complete",
          available_sources: [{
            id: "db",
            label: "db/query",
            surface_id: "surface-mcp",
          }],
        },
      },
    });

    const [evaluation] = await evaluate(
      { atif, taxonomy },
      ["beh-discovered"],
    );
    expect(evaluation.status).toBe("succeeded");
    if (evaluation.status !== "succeeded") return;
    expect(evaluation.result).toEqual({
      state: "completed",
      observed: true,
      occurrences: [
        { evidence: [{ role: "discovery", path: "$.steps[0].extra.scope.discoveries[0]" }] },
        { evidence: [{ role: "discovery", path: "$.steps[1].extra.scope.discoveries[0]" }] },
      ],
    });
  });

  it.each([
    ["complete", "completed", false],
    ["partial", "indeterminate", undefined],
    ["unknown", "indeterminate", undefined],
  ] as const)(
    "returns %s zero-discovery semantics",
    async (trajectoryState, state, observed) => {
      const taxonomy = await loadAgentBehaviorTaxonomy();
      const [evaluation] = await evaluate(
        { atif: input({ trajectoryState }), taxonomy },
        ["beh-discovered"],
      );

      expect(evaluation.status).toBe("succeeded");
      if (evaluation.status !== "succeeded") return;
      expect(evaluation.result).toMatchObject({
        state,
        ...(observed === undefined ? {} : { observed }),
      });
    },
  );
});
