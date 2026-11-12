// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createHandlerRegistry } from "./handlers.js";
import {
  OPTIMIZATION_ARTIFACT_VERSION,
  promptContractHash,
  restoreOptimizationArtifactV2,
  scoreOptimizationCandidate,
  semanticHash,
} from "./optimization-v2.js";
import { createAtifProvenance } from "./atif/index.js";
import { copilotAI } from "./copilot.js";
import {
  createTaxonomyPromptProgram,
  taxonomyPromptEvidence,
} from "./prompt.js";
import { parseScopeAtif } from "./scope-atif.js";
import { loadTaxonomy } from "./taxonomy.js";

async function neutralTaxonomy() {
  return loadTaxonomy(
    new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
    { handlers: createHandlerRegistry() },
  );
}

describe("generic v2 optimization compatibility", () => {
  it("rejects historical artifacts instead of reinterpreting them", async () => {
    const taxonomy = await neutralTaxonomy();
    expect(() => restoreOptimizationArtifactV2(
      { format: "taxonome.ax.v1" },
      taxonomy,
      "test-observation",
      "gpt-4.1",
    )).toThrow(/incompatible/);
  });

  it("requires the exact taxonomy, element, model, and prompt contract", async () => {
    const taxonomy = await neutralTaxonomy();
    const element = taxonomy.elementById.get("test-observation")!;
    const artifact = {
      format: OPTIMIZATION_ARTIFACT_VERSION,
      taxonomy: {
        schema_version: taxonomy.schema_version,
        id: taxonomy.id,
        version: taxonomy.version,
        digest: taxonomy.digest,
      },
      element_id: element.id,
      contract_hash: promptContractHash(taxonomy, element),
      corpus_hash: semanticHash(["input-a", "input-b"]),
      model: "gpt-4.1",
      ax_version: "25.3.2",
      sdk_version: "1.0.1",
      train_ids: ["input-a"],
      validation_ids: ["input-b"],
      settings: { maxMetricCalls: 4, seed: 42, bootstrap: true },
      transport_settings: {
        reasoning_effort: "low",
        sampling: "sdk-managed",
        ax_sampling_hints_applied: false,
      },
      optimized: {
        bestScore: 1,
        stats: {},
        optimizerType: "GEPA",
        optimizationTime: 1,
        totalRounds: 1,
        converged: true,
        demos: [{ evidence: "input-a" }],
      },
      metric_trace: [],
    };

    expect(restoreOptimizationArtifactV2(
      artifact,
      taxonomy,
      element.id,
      "gpt-4.1",
    ).optimized).toMatchObject({
      demos: [{ evidence: "input-a" }],
    });
    expect(() => restoreOptimizationArtifactV2(
      artifact,
      taxonomy,
      element.id,
      "gpt-4.1-mini",
    )).toThrow(/mismatch/);
    expect(() => restoreOptimizationArtifactV2(
      { ...artifact, contract_hash: "tampered" },
      taxonomy,
      element.id,
      "gpt-4.1",
    )).toThrow(/mismatch/);
    expect(() => restoreOptimizationArtifactV2(
      {
        ...artifact,
        metric_trace: [{
          input_id: "input-a",
          score: 1,
          errors: [],
          prediction: {},
        }],
      },
      taxonomy,
      element.id,
      "gpt-4.1",
    )).toThrow(/rerun optimization explicitly/);
    expect(promptContractHash(
      taxonomy,
      {
        ...element,
        output: {
          ...element.output,
          constraints: [{
            kind: "after",
            role: "step",
            reference_role: "step",
            within: "$.steps",
          }],
        },
      },
    )).not.toBe(artifact.contract_hash);
    expect(promptContractHash(
      taxonomy,
      {
        ...element,
        preconditions: {
          ...element.preconditions,
          requires_task: !element.preconditions.requires_task,
        },
      },
    )).not.toBe(artifact.contract_hash);
  });

  it("hard-scores wrong evidence references zero without repair or model calls", async () => {
    const root = fileURLToPath(new URL(
      "../conformance/trajectory-taxonomy-format/",
      import.meta.url,
    ));
    const taxonomy = await loadTaxonomy(`${root}valid/taxonomy.yaml`, {
      handlers: createHandlerRegistry(),
    });
    const atif = parseScopeAtif(JSON.parse(await readFile(
      `${root}valid/atif-v17.json`,
      "utf8",
    )) as unknown);
    const input = {
      id: "optimizer-reference-test",
      family: "optimizer-reference-family",
      originating_run: "optimizer-reference-run",
      split: "train" as const,
      provenance: "optimizer reference validation",
      elements: ["malformed"],
      atif,
      source_file: "fixture.jsonl",
      source_line: 1,
      atif_provenance: createAtifProvenance(
        { file: "fixture.jsonl", jsonl_line: 1 },
        "$.atif",
        "ATIF-v1.7",
      ),
    };
    const expected = {
      state: "completed" as const,
      observed: true as const,
      occurrences: [{
        evidence: [
          { role: "call", path: "$.steps[1].tool_calls[0]" },
          {
            role: "issue",
            path:
              "$.steps[1].tool_calls[0].extra.scope.input_validation.issues[0]",
          },
        ],
      }],
    };
    const scored = scoreOptimizationCandidate(
      {
        state: "completed",
        observed: true,
        occurrences: [{
          evidence: [
            { role: "call", path: "$.steps[0]" },
            ...expected.occurrences[0].evidence.slice(1),
          ],
        }],
      },
      input,
      taxonomy.elementById.get("malformed")!,
      expected,
    );
    expect(scored.score).toBe(0);
    expect(scored.dimensions.types_valid).toBe(false);
    expect(scored.dimensions.constraints_valid).toBe(false);
    expect(scored.dimensions.semantic_match).toBe(false);
    expect(scored.diagnostics.map(item => item.code))
      .toContain("reference_type_mismatch");

    const doubleEncoded = scoreOptimizationCandidate(
      JSON.stringify(expected),
      input,
      taxonomy.elementById.get("malformed")!,
      expected,
    );
    expect(doubleEncoded).toMatchObject({
      score: 0,
      dimensions: { schema_valid: false },
      diagnostics: [{ code: "schema_mismatch" }],
    });

  });

  it("returns parser failures for zero-score optimizer fitness without correction", async () => {
    const taxonomy = await neutralTaxonomy();
    const element = taxonomy.elementById.get("test-observation")!;
    const atif = parseScopeAtif({
      schema_version: "ATIF-v1.8",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [{ step_id: 1, source: "user", message: "Test." }],
    });
    const program = createTaxonomyPromptProgram(
      element,
      undefined,
      {
        correctionRetries: 0,
        captureInvalidOutput: true,
      },
    );
    const complete = vi.fn(async () => ({
      content: "Observation: {not-json",
    }));
    const prediction = await program.forward(
      copilotAI({ complete, close: async () => { } }, "mock"),
      { trajectory_context: taxonomyPromptEvidence({ atif, taxonomy }) },
    );

    expect(prediction).toEqual({ observation: undefined });
    expect(complete).toHaveBeenCalledOnce();
    const input = {
      id: "optimizer-parser-test",
      family: "optimizer-parser-family",
      originating_run: "optimizer-parser-run",
      split: "train" as const,
      provenance: "optimizer parser validation",
      elements: [element.id],
      atif,
      source_file: "fixture.jsonl",
      source_line: 1,
      atif_provenance: createAtifProvenance(
        { file: "fixture.jsonl", jsonl_line: 1 },
        "$.atif",
        "ATIF-v1.8",
      ),
    };
    expect(scoreOptimizationCandidate(
      prediction.observation,
      input,
      element,
      { state: "completed", observed: false },
    )).toMatchObject({
      score: 0,
      dimensions: { schema_valid: false },
      diagnostics: [{ code: "schema_mismatch" }],
    });

    await expect(program.forward(
      copilotAI({
        complete: async () => {
          throw new Error("transport unavailable");
        },
        close: async () => { },
      }, "mock"),
      { trajectory_context: taxonomyPromptEvidence({ atif, taxonomy }) },
    )).rejects.toThrow("transport unavailable");
  });
});
