// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { evaluate } from "./engine.js";
import { HandlerRegistry } from "./handlers.js";
import { parseScopeAtif } from "./scope-atif.js";
import { loadTaxonomy } from "./taxonomy.js";

async function neutralTaxonomy() {
  return loadTaxonomy(
    new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
    { handlers: new HandlerRegistry() },
  );
}

describe("generic taxonomy engine", () => {
  it("hides private maps from handlers and grounds every related turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-handler-input-"));
    try {
      const registry = new HandlerRegistry();
      registry.register({
        "acme/grounding-test-v1": {
          configSchema: z.object({}).strict(),
          evaluate(input, config) {
            expect(Object.isFrozen(input)).toBe(true);
            expect(Object.isFrozen(input.atif)).toBe(true);
            expect(Object.isFrozen(config)).toBe(true);
            expect("elementById" in input.taxonomy).toBe(false);
            expect("surfaceById" in input.taxonomy).toBe(false);
            return {
              state: "completed",
              observed: true,
              occurrences: [{
                related_turns: [1, 999],
                tool_call_id: "call-1",
              }],
            };
          },
        },
      }, {
        name: "grounding-test",
        origin: "local",
      });
      const path = join(directory, "taxonomy.yaml");
      await writeFile(path, `
schema_version: scope/taxonomy/v1
id: grounding-test
version: 1.0.0
surfaces: []
elements:
  - id: grounding
    label: Grounding
    implementation:
      type: deterministic
      handler: acme/grounding-test-v1
    evidence:
      requires_discovery_event: false
      complete_for_negative: false
      requires_task: false
    output_schema:
      type: object
      additionalProperties: false
      required: [state, observed, occurrences]
      properties:
        state: { const: completed }
        observed: { const: true }
        occurrences:
          type: array
          minItems: 1
          items:
            type: object
            additionalProperties: false
            required: [related_turns, tool_call_id]
            properties:
              related_turns:
                type: array
                minItems: 1
                items: { type: integer, minimum: 1 }
              tool_call_id: { type: string }
`);
      const taxonomy = await loadTaxonomy(path, { handlers: registry });
      const atif = parseScopeAtif({
        schema_version: "ATIF-v1.7",
        session_id: "grounding",
        agent: { name: "fixture" },
        steps: [{
          step_id: 1,
          source: "agent",
          message: "Called.",
          tool_calls: [{
            tool_call_id: "call-1",
            function_name: "query",
            arguments: {},
          }],
        }],
      });

      await expect(evaluate(
        { atif, taxonomy },
        ["grounding"],
      )).rejects.toThrow(/related_turns contains unknown step 999/);
      expect(taxonomy.elementById.has("grounding")).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects invented occurrence sources after schema validation", async () => {
    const taxonomy = await neutralTaxonomy();
    const atif = parseScopeAtif({
      schema_version: "ATIF-v1.7",
      session_id: "source-grounding",
      agent: { name: "fixture" },
      steps: [{ step_id: 1, source: "user", message: "Test." }],
    });
    await expect(evaluate(
      { atif, taxonomy },
      ["test-observation"],
      {
        evaluate: async () => ({
          state: "completed",
          observed: true,
          occurrences: [{
            source: {
              id: "invented",
              label: "Invented",
              surface_id: "surface-mcp",
            },
          }],
        }),
      },
    )).rejects.toThrow("not a supplied Scope source");
  });

  it("defaults plain ATIF to complete and rejects duplicate selections", async () => {
    const taxonomy = await neutralTaxonomy();
    const atif = parseScopeAtif({
      schema_version: "ATIF-v1.7",
      session_id: "plain",
      agent: { name: "fixture" },
      steps: [{ step_id: 1, source: "user", message: "Say hello." }],
    });

    expect(atif.extra?.scope?.trajectory_state).toBe("complete");
    await expect(evaluate(
      { atif, taxonomy },
      ["test-observation", "test-observation"],
      { evaluate: async () => ({ state: "completed" }) },
    )).rejects.toThrow("unique element selection");
  });
});
