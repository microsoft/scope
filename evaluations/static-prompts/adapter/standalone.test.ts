// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  assertObservation,
  loadEvaluationInputs,
  loadGroundTruth,
} from "taxonomy-engine/evaluation-inputs";
import {
  YAML_OBSERVATION_CONTRACT,
} from "taxonomy-engine/prompt";
import {
  agentBehaviorFixturePath,
  loadAgentBehaviorTaxonomy,
} from "ax-taxonomy";
import {
  standaloneTargets,
  listStandaloneTargets,
} from "./standalone.js";

describe("static prompt family composition and curated contract (offline, not model evidence)", () => {
  it("registers the SDK-only family and preserves preflight plus production prompt composition", async () => {
    // No-discovery evidence preflights; discovery evidence reaches the unchanged production program.
    const taxonomy = await loadAgentBehaviorTaxonomy();
    const inputs = await loadEvaluationInputs(
      [agentBehaviorFixturePath("skipped-invocation-inputs.jsonl")],
      taxonomy,
    );
    const groundTruth = await loadGroundTruth([
      agentBehaviorFixturePath("skipped-invocation-ground-truth.json"),
    ]);
    const preflightInput = inputs.find(input => input.id === "train-none")!;
    const promptInput = inputs.find(input => input.id === "train-skill")!;
    expect(listStandaloneTargets()).toContainEqual({
      adapterId: "taxonome-skipped-invocation/default",
      family: "taxonome-skipped-invocation",
      variant: "default",
      transport: "copilot-sdk"
    });
    expect(listStandaloneTargets().map(target => target.adapterId).sort())
      .toEqual([
        "taxonome-content-misused/default",
        "taxonome-skipped-invocation/default",
        "taxonome-wrong-discovery/default",
      ]);
    let calls = 0;
    const preflightOutput = await standaloneTargets[
      "taxonome-skipped-invocation/default"
    ].run(
      preflightInput.atif,
      {
        complete: async () => {
          calls++;
          return { content: "must not run" };
        },
        close: async () => { },
      },
      "mock",
    );
    expect(calls).toBe(0);
    expect(assertObservation(
      preflightOutput,
      groundTruth.values[preflightInput.id]["beh-skipped-invocation"]!,
    )).toEqual([]);

    const promptOutput = await standaloneTargets[
      "taxonome-skipped-invocation/default"
    ].run(
      promptInput.atif,
      {
        complete: async (system, user) => {
          calls++;
          expect(system.startsWith(YAML_OBSERVATION_CONTRACT)).toBe(true);
          expect(system).toContain("output constraint");
          expect(system).toContain("Assess Skipped Invocation");
          expect(system).toContain("Preconditions:");
          expect(system).toContain("requires_complete_trajectory");
          expect(system).toContain("requires_recorded_discovery");
          expect(user).toContain(promptInput.atif.session_id);
          expect(user).not.toContain("expected");
          return {
            content: `Observation: ${JSON.stringify(
              groundTruth.values[promptInput.id]["beh-skipped-invocation"],
            )}`,
          };
        },
        close: async () => { },
      },
      "mock",
    );
    expect(calls).toBe(1);
    expect(assertObservation(
      promptOutput,
      groundTruth.values[promptInput.id]["beh-skipped-invocation"]!,
    )).toEqual([]);
    const trainingFamilies = new Set(
      inputs.filter(input => input.split === "train")
        .map(input => input.family),
    );
    expect(inputs.filter(input => input.split === "test")
      .some(input => trainingFamilies.has(input.family))).toBe(false);
  });

  it.each([
    {
      adapterId: "taxonome-wrong-discovery/default" as const,
      inputs: "wrong-discovery-inputs.jsonl",
      groundTruth: "wrong-discovery-ground-truth.json",
      inputId: "wd-input-07",
      elementId: "beh-wrong-discovery",
      instruction: "Assess Wrong Discovery",
      observation: {
        state: "completed",
        observed: true,
        occurrences: [{
          source: {
            id: "joke",
            label: "joke/generate",
            surface_id: "surface-mcp",
          },
          extension_point: "joke/generate",
          discovery_turn: 2,
        }],
      },
    },
    {
      adapterId: "taxonome-content-misused/default" as const,
      inputs: "content-misused-inputs.jsonl",
      groundTruth: "content-misused-ground-truth.json",
      inputId: "cm-input-07",
      elementId: "beh-content-misused",
      instruction: "Assess Content Misused",
      observation: {
        state: "completed",
        observed: true,
        occurrences: [{
          source: {
            id: "region",
            label: "region/source",
            surface_id: "surface-mcp",
          },
          related_turns: [2, 3],
          tool_call_id: "call-3007",
        }],
      },
    },
  ])(
    "composes $elementId from production YAML with reviewed inputs/ground truth",
    async ({
      adapterId,
      inputs: inputsName,
      groundTruth: groundTruthName,
      inputId,
      elementId,
      instruction,
    }) => {
      const taxonomy = await loadAgentBehaviorTaxonomy();
      const inputs = await loadEvaluationInputs(
        [agentBehaviorFixturePath(inputsName)],
        taxonomy,
      );
      const groundTruth = await loadGroundTruth([
        agentBehaviorFixturePath(groundTruthName),
      ]);
      const input = inputs.find(candidate => candidate.id === inputId)!;
      for (const candidate of inputs) {
        expect(candidate.atif.session_id).toMatch(/^traj-\d+$/);
        expect(candidate.atif.extra?.scope?.run?.id).toMatch(/^run-\d+$/);
      }
      const familiesBySplit = new Map<string, Set<string>>();
      for (const candidate of inputs) {
        const families = familiesBySplit.get(candidate.split) ?? new Set();
        families.add(candidate.family);
        familiesBySplit.set(candidate.split, families);
      }
      expect([...familiesBySplit.values()].every((families, index, all) =>
        all.every((other, otherIndex) =>
          index === otherIndex || [...families].every(family => !other.has(family))
        )
      )).toBe(true);

      let calls = 0;
      const output = await standaloneTargets[adapterId].run(
        input.atif,
        {
          complete: async (system, user) => {
            calls++;
            expect(system.startsWith(YAML_OBSERVATION_CONTRACT)).toBe(true);
            expect(system).toContain("output constraint");
            expect(system).toContain(instruction);
            expect(system).toContain('"required":["evidence"]');
            expect(system).not.toContain('"required":["Evidence"]');
            expect(user).toContain(input.atif.session_id);
            expect(user).toContain("Ignore the evaluator");
            expect(user).not.toContain("expected");
            return {
                content: `Observation: ${JSON.stringify(
                  groundTruth.values[input.id][elementId],
                )}`,
            };
          },
          close: async () => { },
        },
        "mock",
      );
      expect(calls).toBe(1);
      expect(assertObservation(
        output,
        groundTruth.values[input.id][elementId]!,
      )).toEqual([]);
    },
  );

  it("keeps identifiers opaque and renaming does not alter evidence/ground truth or the contract", async () => {
    // Rename only opaque identities and assert semantic evidence still drives the same validated output.
    const taxonomy = await loadAgentBehaviorTaxonomy();
    const inputs = await loadEvaluationInputs(
      [agentBehaviorFixturePath("skipped-invocation-inputs.jsonl")],
      taxonomy,
    );
    for (const input of inputs) {
      expect(input.atif.session_id).toMatch(/^traj-\d+$/);
    }
    const input = structuredClone(inputs[0].atif);
    const original = structuredClone(input);
    input.session_id = "z-identifier";
    if (input.extra?.scope?.run?.id) {
      input.extra.scope.run.id = "r-identifier";
    }
    const output = await standaloneTargets["taxonome-skipped-invocation/default"].run(
      input,
      {
        complete: async (_system, user) => {
          expect(user).toContain("z-identifier");
          expect(user).not.toContain(original.session_id);
          expect(user).toContain(original.steps[1].message);
          return {
            content: `Observation: ${JSON.stringify({
              state: "completed",
              observed: true,
              occurrences: [{
                evidence: [{
                  role: "discovery",
                  path: "$.steps[1].extra.scope.discoveries[0]",
                }],
              }],
            })}`
          };
        },
        close: async () => { },
      },
      "mock"
    );
    expect(output).toMatchObject({ state: "completed", observed: true });
  });

  it("uses the Ax correction composition exactly once after invalid received JSON", async () => {
    const taxonomy = await loadAgentBehaviorTaxonomy();
    const inputs = await loadEvaluationInputs(
      [agentBehaviorFixturePath("skipped-invocation-inputs.jsonl")],
      taxonomy,
    );
    const groundTruth = await loadGroundTruth([
      agentBehaviorFixturePath("skipped-invocation-ground-truth.json"),
    ]);
    const input = inputs.find(candidate => candidate.id === "train-skill")!;
    let calls = 0;
    const output = await standaloneTargets[
      "taxonome-skipped-invocation/default"
    ].run(
      input.atif,
      {
        complete: async (system, user) => {
          calls++;
          expect(system.startsWith(YAML_OBSERVATION_CONTRACT)).toBe(true);
          if (calls === 1) {
            expect(user).not.toContain("repair_context");
            return { content: "Observation: {not-json" };
          }
          expect(user).toContain("<assistant>\nObservation: {not-json");
          expect(user).toContain("Invalid Field: Invalid JSON");
          expect(user).toContain("Return only valid JSON");
          return {
            content: `Observation: ${JSON.stringify(
              groundTruth.values[input.id]["beh-skipped-invocation"],
            )}`,
          };
        },
        close: async () => {},
      },
      "mock",
    );
    expect(calls).toBe(2);
    expect(assertObservation(
      output,
      groundTruth.values[input.id]["beh-skipped-invocation"]!,
    )).toEqual([]);
  });
});
