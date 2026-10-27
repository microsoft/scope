// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertObservationV2,
  checkCaseV2,
  loadCasesV2,
  type EvaluationCaseV2,
  type GoldV2,
} from "./cases-v2.js";
import type { Evaluation } from "./engine.js";
import { createHandlerRegistry } from "./handlers.js";
import { loadTaxonomy } from "./taxonomy.js";

async function neutralTaxonomy() {
  return loadTaxonomy(
    new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
    { handlers: createHandlerRegistry() },
  );
}

describe("generic v2 case and gold assertions", () => {
  it("counts missing, duplicate, and unexpected evaluation envelopes", async () => {
    const taxonomy = await neutralTaxonomy();
    const row: EvaluationCaseV2 = {
      id: "case-01",
      family: "family-01",
      originating_run: "origin-01",
      split: "unit",
      provenance: "neutral engine fixture",
      elements: ["test-observation"],
      atif: {
        schema_version: "ATIF-v1.7",
        session_id: "session-01",
        agent: { name: "fixture" },
        steps: [{ step_id: 1, source: "user", message: "Test." }],
        extra: {
          scope: {
            schema_version: "scope.atif-extension.v1",
            trajectory_state: "complete",
            available_sources: [],
          },
        },
      },
    };
    const gold: GoldV2 = {
      "case-01": {
        "test-observation": {
          state: "completed",
          observed: false,
        },
      },
    };
    const evaluation: Evaluation = {
      schema_version: "scope/taxonomy-evaluation/v1",
      taxonomy: {
        id: taxonomy.id,
        version: taxonomy.version,
        digest: taxonomy.digest,
      },
      element: { id: "test-observation", label: "Test Observation" },
      implementation: { type: "prompt" },
      result: { state: "completed", observed: false },
    };

    expect(checkCaseV2(row, [], gold)).toEqual([
      "Expected exactly one result for test-observation, got 0",
    ]);
    expect(checkCaseV2(row, [evaluation], gold)).toEqual([]);
    expect(checkCaseV2(row, [evaluation, evaluation], gold))
      .toContain("Expected exactly one result for test-observation, got 2");
  });

  it("treats omitted occurrence fields as unconstrained", () => {
    expect(assertObservationV2({
      state: "completed",
      observed: true,
      occurrences: [{
        source: { id: "s", label: "Source", surface_id: "surface-mcp" },
        related_turns: [2],
        tool_call_id: "c",
      }],
    }, {
      state: "completed",
      observed: true,
      occurrences: [{ tool_call_id: "c" }],
    })).toEqual([]);
  });

  it("rejects family and originating-run leakage between splits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonomy-cases-"));
    const path = join(directory, "cases.jsonl");
    const atif = {
      schema_version: "ATIF-v1.7",
      session_id: "session",
      agent: { name: "fixture" },
      steps: [{ step_id: 1, source: "user", message: "Test." }],
    };
    await writeFile(path, [
      {
        id: "train",
        family: "shared",
        originating_run: "origin-a",
        split: "train",
        provenance: "fixture",
        elements: ["test-observation"],
        atif,
      },
      {
        id: "heldout",
        family: "shared",
        originating_run: "origin-b",
        split: "heldout",
        provenance: "fixture",
        elements: ["test-observation"],
        atif: { ...atif, session_id: "session-2" },
      },
    ].map(value => JSON.stringify(value)).join("\n"));
    try {
      await expect(loadCasesV2(path, await neutralTaxonomy()))
        .rejects.toThrow("leakage");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
