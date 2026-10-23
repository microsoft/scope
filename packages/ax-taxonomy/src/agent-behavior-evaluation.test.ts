// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  evaluate,
  parseScopeAtif,
} from "taxonomy-engine";
import {
  agentBehaviorFixturePath,
  loadAgentBehaviorTaxonomy,
} from "./index.js";

async function taxonomy() {
  return loadAgentBehaviorTaxonomy();
}

/** Reads one v2 case row by ID from committed JSONL. */
async function caseAtif(id: string) {
  const rows = (await readFile(
    agentBehaviorFixturePath("final-inputs.jsonl"),
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

    expect(evaluation).toMatchObject({
      schema_version: "scope/taxonomy-evaluation/v1",
      taxonomy: {
        id: "agent-behavior",
        version: "2.0.0",
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
      },
      result: {
        state: "completed",
        observed: true,
        occurrences: [{
          related_turns: [2],
          tool_call_id: "query-1",
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
          state: "completed",
          observed: true,
          occurrences: [{
            extension_point: "login/configure",
            source: {
              id: "ep-071",
              label: "login/configure",
              surface_id: "surface-auth",
            },
            discovery_turn: 2,
          }],
        };
      }),
    };

    const [evaluation] = await evaluate(
      { atif, taxonomy: loaded },
      ["beh-skipped-invocation"],
      executor,
    );

    expect(evaluation.result).toMatchObject({
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

    expect(skipped.result).toMatchObject({ state: "indeterminate" });
    expect(timeout.result).toMatchObject({ state: "completed", observed: true });
    expect(executor.evaluate).not.toHaveBeenCalled();
  });

});
