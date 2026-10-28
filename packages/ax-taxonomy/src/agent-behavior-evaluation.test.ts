// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  evaluate,
  parseScopeAtif,
  type Evaluation,
  type SucceededEvaluation,
} from "taxonomy-engine";
import {
  loadEvaluationInputs,
  loadGroundTruth,
} from "taxonomy-engine/evaluation-inputs";
import {
  agentBehaviorFixturePath,
  loadAgentBehaviorTaxonomy,
} from "./index.js";

async function taxonomy() {
  return loadAgentBehaviorTaxonomy();
}

function succeeded(evaluation: Evaluation): SucceededEvaluation {
  expect(evaluation.status).toBe("succeeded");
  if (evaluation.status !== "succeeded") {
    throw new Error(evaluation.error.message);
  }
  return evaluation;
}

/** Reads one evaluation input by ID from committed JSONL. */
async function caseAtif(id: string) {
  const rows = (await readFile(
    agentBehaviorFixturePath("skipped-invocation-test-inputs.jsonl"),
    "utf8",
  )).trim().split("\n").map(line => JSON.parse(line) as {
    id: string;
    atif: unknown;
  });
  return parseScopeAtif(rows.find(row => row.id === id)!.atif);
}

describe("agent-behavior catalog definitions and handlers", () => {
  it("evaluates deterministic Timeout with zero prompt executor calls", async () => {
    const loaded = await taxonomy();
    const atif = parseScopeAtif(JSON.parse(await readFile(
      agentBehaviorFixturePath("timeout.atif.json"),
      "utf8",
    )) as unknown);
    const executor = { evaluate: vi.fn() };
    const before = structuredClone(atif);

    const [evaluation] = await evaluate(
      { atif, taxonomy: loaded },
      ["beh-timeout"],
      executor,
    );

    expect(succeeded(evaluation)).toMatchObject({
      schema_version: "scope/taxonomy-evaluation/v1",
      taxonomy: {
        id: "agent-behavior",
        version: "3.0.0",
        digest: loaded.digest,
      },
      element: {
        id: "beh-timeout",
        label: "Timeout",
        category_id: "behavior-category-invocation",
      },
      implementation: {
        type: "deterministic",
        handler: "scope/timeout-v1",
        provider: { origin: "builtin" },
        attempts: [{ outcome: "succeeded" }],
      },
      status: "succeeded",
      result: {
        state: "completed",
        observed: true,
        occurrences: [{
          evidence: [{
            role: "call",
            path: "$.steps[1].tool_calls[0]",
          }],
        }],
      },
    });
    expect(executor.evaluate).not.toHaveBeenCalled();
    expect(atif).toEqual(before);
    expect(Object.isFrozen(atif)).toBe(false);
    expect(Object.isFrozen(atif.steps[0])).toBe(false);
  });

  it("uses loaded prompt instructions and grounds a positive discovery occurrence", async () => {
    const loaded = await taxonomy();
    const atif = await caseAtif("final-login");
    const executor = {
      evaluate: vi.fn(async element => {
        expect(element.implementation).toMatchObject({
          type: "prompt",
          prompt: expect.stringContaining("Assess Skipped Invocation"),
        });
        return {
          status: "succeeded" as const,
          candidate: {
            state: "completed",
            observed: true,
            occurrences: [{
              evidence: [{
                role: "discovery",
                path: "$.steps[1].extra.scope.discoveries[0]",
              }],
            }],
          },
          attempts: [{
            attempt: 1 as const,
            kind: "initial" as const,
            outcome: "succeeded" as const,
          }],
        };
      }),
    };

    const [evaluation] = await evaluate(
      { atif, taxonomy: loaded },
      ["beh-skipped-invocation"],
      executor,
    );

    expect(succeeded(evaluation).result).toMatchObject({
      state: "completed",
      observed: true,
    });
    expect(executor.evaluate).toHaveBeenCalledOnce();
  });

  it("preflights incomplete absence claims without calling a prompt and keeps explicit Timeout positive", async () => {
    const loaded = await taxonomy();
    const atif = await caseAtif("final-partial-mixed");
    const executor = { evaluate: vi.fn() };

    const [skipped, timeout] = await evaluate(
      { atif, taxonomy: loaded },
      ["beh-skipped-invocation", "beh-timeout"],
      executor,
    );

    expect(succeeded(skipped).result).toMatchObject({ state: "indeterminate" });
    expect(succeeded(timeout).result).toMatchObject({ state: "completed", observed: true });
    expect(executor.evaluate).not.toHaveBeenCalled();
  });

  it("preflights available-but-undiscovered sources as completed absence", async () => {
    const loaded = await taxonomy();
    const atif = await caseAtif("final-available-only");
    const executor = { evaluate: vi.fn() };

    const [evaluation] = await evaluate(
      { atif, taxonomy: loaded },
      ["beh-skipped-invocation"],
      executor,
    );

    expect(succeeded(evaluation).result).toEqual({
      state: "completed",
      observed: false,
    });
    expect(atif.extra?.scope?.available_sources).toHaveLength(1);
    expect(atif.steps.every(step =>
      !(step.extra?.scope?.discoveries?.length)
    )).toBe(true);
    expect(executor.evaluate).not.toHaveBeenCalled();
  });

  it("loads and evaluates the catalog-owned deterministic element fixture", async () => {
    const loaded = await taxonomy();
    const atif = parseScopeAtif(JSON.parse(await readFile(
      agentBehaviorFixturePath("deterministic-elements.atif.json"),
      "utf8",
    )) as unknown);

    const [discovered, malformed] = await evaluate(
      { atif, taxonomy: loaded },
      ["beh-discovered", "beh-malformed-invocation"],
    );

    expect(succeeded(discovered).result).toMatchObject({
      state: "completed",
      observed: true,
      occurrences: [{
        evidence: [{
          role: "discovery",
          path: "$.steps[1].extra.scope.discoveries[0]",
        }],
      }],
    });
    expect(succeeded(malformed).result).toMatchObject({
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
    [
      "wrong-discovery-inputs.jsonl",
      "wrong-discovery-ground-truth.json",
      "beh-wrong-discovery",
    ],
    [
      "content-misused-inputs.jsonl",
      "content-misused-ground-truth.json",
      "beh-content-misused",
    ],
  ])(
    "loads disjoint opaque prompt inputs %s with separate reviewed ground truth",
    async (inputsName, groundTruthName, elementId) => {
      const loaded = await taxonomy();
      const inputs = await loadEvaluationInputs(
        [agentBehaviorFixturePath(inputsName)],
        loaded,
      );
      const groundTruth = await loadGroundTruth([
        agentBehaviorFixturePath(groundTruthName),
      ]);

      expect(inputs).toHaveLength(9);
      expect(new Set(inputs.map(input => input.family)).size).toBe(9);
      expect(new Set(inputs.map(input => input.originating_run)).size).toBe(9);
      expect(inputs.every(input =>
        input.elements.join(",") === elementId
      )).toBe(true);
      expect(inputs.every(input =>
        typeof input.atif.session_id === "string" &&
        /^traj-\d+$/.test(input.atif.session_id)
      ))
        .toBe(true);
      expect(inputs.every(input =>
        groundTruth.values[input.id]?.[elementId]
      )).toBe(true);
    },
  );

  it("preflights new prompt corpora without initializing an executor", async () => {
    const loaded = await taxonomy();
    const wrongInputs = await loadEvaluationInputs(
      [agentBehaviorFixturePath("wrong-discovery-inputs.jsonl")],
      loaded,
    );
    const contentInputs = await loadEvaluationInputs(
      [agentBehaviorFixturePath("content-misused-inputs.jsonl")],
      loaded,
    );
    const executor = { evaluate: vi.fn() };

    const [noDiscovery] = await evaluate(
      {
        atif: wrongInputs.find(input => input.id === "wd-input-03")!.atif,
        taxonomy: loaded,
      },
      ["beh-wrong-discovery"],
      executor,
    );
    const [partial] = await evaluate(
      {
        atif: contentInputs.find(input => input.id === "cm-input-06")!.atif,
        taxonomy: loaded,
      },
      ["beh-content-misused"],
      executor,
    );
    const [missingTask] = await evaluate(
      {
        atif: contentInputs.find(input => input.id === "cm-input-09")!.atif,
        taxonomy: loaded,
      },
      ["beh-content-misused"],
      executor,
    );

    expect(succeeded(noDiscovery).result).toEqual({
      state: "completed",
      observed: false,
    });
    expect(succeeded(partial).result).toMatchObject({ state: "indeterminate" });
    expect(succeeded(missingTask).result).toMatchObject({ state: "indeterminate" });
    expect(executor.evaluate).not.toHaveBeenCalled();
  });

});
