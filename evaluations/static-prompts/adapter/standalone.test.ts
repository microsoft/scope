// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  assertObservationV2,
  loadCasesV2,
  loadGoldV2,
} from "taxonomy-engine/cases-v2";
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
  it("registers the real SDK-only family and invokes the production program unchanged", async () => {
    // The fake transport captures the exact production composition without substituting a prompt copy.
    const taxonomy = await loadAgentBehaviorTaxonomy();
    const cases = await loadCasesV2(
      agentBehaviorFixturePath("inputs.jsonl"),
      taxonomy,
    );
    const gold = await loadGoldV2(agentBehaviorFixturePath("gold.json"));
    const row = cases.find(c => c.id === "train-none")!;
    expect(listStandaloneTargets()).toContainEqual({
      adapterId: "taxonome-skipped-invocation/default",
      family: "taxonome-skipped-invocation",
      variant: "default",
      transport: "copilot-sdk"
    });
    let calls = 0;
    const output = await standaloneTargets["taxonome-skipped-invocation/default"].run(
      row.atif,
      {
        complete: async (system, user) => {
          calls++;
          expect(system.startsWith(YAML_OBSERVATION_CONTRACT)).toBe(true);
          expect(system).toContain("Assess Skipped Invocation");
          expect(user).toContain(row.atif.session_id);
          expect(user).not.toContain("expected");
          return { content: 'Observation: {"state":"completed","observed":false}' };
        },
        close: async () => { },
      },
      "mock"
    );
    expect(calls).toBe(1);
    expect(assertObservationV2(
      output,
      gold[row.id]["beh-skipped-invocation"]!,
    )).toEqual([]);
    const trainingFamilies = new Set(cases.filter(c => c.split === "train").map(c => c.family));
    expect(cases.filter(c => c.split === "heldout").some(c => trainingFamilies.has(c.family))).toBe(false);
  });
  it("keeps identifiers opaque and renaming does not alter evidence/gold or the contract", async () => {
    // Rename only opaque identities and assert semantic evidence still drives the same validated output.
    const taxonomy = await loadAgentBehaviorTaxonomy();
    const rows = await loadCasesV2(
      agentBehaviorFixturePath("inputs.jsonl"),
      taxonomy,
    );
    for (const row of rows) expect(row.atif.session_id).toMatch(/^traj-\d+$/);
    const input = structuredClone(rows[0].atif);
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
                source: input.extra!.scope!.available_sources[0],
                extension_point: "storage-skill",
                discovery_turn: 2,
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
});
