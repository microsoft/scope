// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createHandlerRegistry } from "./handlers.js";
import {
  AxOptimizationProgressReporter,
  OPTIMIZATION_MANIFEST_VERSION,
  optimizationManifestSchema,
  optimizationFeedbackForCandidate,
  optimizePromptElement,
  promptContractHash,
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

describe("instruction-only optimization contract", () => {
  it("maps structured Ax events without inventing unavailable signals", () => {
    const progress: Array<Record<string, unknown>> = [];
    const reporter = new AxOptimizationProgressReporter(
      "prompt-a",
      () => 7,
      event => progress.push(event),
      "prompt-a::instruction",
      "naive",
    );

    reporter.handle({
      name: "OptimizationStart",
      value: {
        optimizerType: "GEPA",
        config: {},
        exampleCount: 2,
        validationCount: 2,
      },
    });
    reporter.handle({
      name: "ConfigurationProposal",
      value: {
        type: "instructions",
        proposals: ["candidate"],
        count: 3,
      },
    });
    reporter.handle({
      name: "RoundProgress",
      value: {
        round: 2,
        totalRounds: 4,
        currentScore: 0.5,
        bestScore: 0.75,
        configuration: {},
        paretoFrontSize: 2,
      },
    });
    reporter.handle({
      name: "EarlyStopping",
      value: { reason: "patience exhausted", finalScore: 0.75, round: 3 },
    });
    reporter.handle({
      name: "OptimizationComplete",
      value: {
        bestScore: 0.75,
        bestConfiguration: {},
        stats: {},
      },
    });
    reporter.handleLogger({
      name: "Notification",
      id: "gepa_teacher",
      value: "teacher failed token=synthetic-secret",
    });
    reporter.handleRoundProgress({
      round: 3,
      totalRounds: 4,
      currentScore: 0.75,
      bestScore: 1,
      currentConfiguration: {
        "prompt-a::instruction": "improved",
      },
    });
    reporter.handle("unstructured text");

    expect(progress).toEqual([
      expect.objectContaining({
        phase: "optimizing",
        elementId: "prompt-a",
        metricCalls: 7,
        message: "GEPA started",
      }),
      expect.objectContaining({
        candidateCount: 3,
        message: "instructions proposal",
      }),
      expect.objectContaining({
        phase: "candidate",
        trial: 2,
        totalTrials: 4,
        candidateCount: 3,
        latestScore: 0.5,
        bestScore: 0.75,
        paretoFrontSize: 2,
      }),
      expect.objectContaining({
        trial: 3,
        latestScore: 0.75,
        stopReason: "patience exhausted",
      }),
      expect.objectContaining({
        bestScore: 0.75,
        stopReason: "patience exhausted",
        message: "optimizer complete",
      }),
      expect.objectContaining({
        phase: "optimizing",
        message: "teacher failed token=[redacted]",
      }),
      expect.objectContaining({
        phase: "candidate",
        trial: 3,
        totalTrials: 4,
        latestScore: 0.75,
        bestScore: 1,
        candidateCount: 3,
        candidateChanged: true,
        message: "trial 3/4; candidate changed",
      }),
    ]);
    expect(progress[0]).not.toHaveProperty("trial");
    expect(progress[0]).not.toHaveProperty("paretoFrontSize");
  });

  it("reports exact measured evaluator defects without feedback on passes", () => {
    const failing: OptimizationCandidateScore = {
      score: 0,
      errors: ["observed expected false"],
      diagnostics: [],
      dimensions: {
        schema_valid: true,
        roles_valid: true,
        references_resolved: true,
        types_valid: true,
        constraints_valid: true,
        semantic_match: false,
      },
    };
    expect(optimizationFeedbackForCandidate(failing)).toEqual([
      "Assessment mismatch: observed expected false",
    ]);
    expect(optimizationFeedbackForCandidate({
      ...failing,
      score: 1,
      errors: [],
      dimensions: { ...failing.dimensions, semantic_match: true },
    })).toBeUndefined();
  });

  it("uses real GEPA proposal and Validation selection to replace a naive instruction", async () => {
    const base = await neutralTaxonomy();
    const source = base.elementById.get("test-observation")!;
    const taxonomy = await loadTaxonomy(
      new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
      {
        handlers: createHandlerRegistry(),
        elementOverrides: new Map([[
          source.id,
          {
            schema_version: "scope/taxonomy/v1",
            id: source.id,
            label: "Repeated Request",
            description: "The agent asks again for information already discussed.",
            implementation: {
              type: "prompt",
              prompt: "Decide whether repeated-request behavior occurred.",
            },
            preconditions: source.preconditions,
            output: source.output,
          },
        ]]),
      },
    );
    const makeInput = (
      id: string,
      split: "train" | "validation",
      confirmation: boolean,
    ) => ({
      id,
      family: `${id}-family`,
      originating_run: `${id}-run`,
      split,
      provenance: "optimizer proposal regression",
      elements: [source.id],
      atif: parseScopeAtif({
        schema_version: "ATIF-v1.8",
        agent: { name: "fixture", version: "1.0.0" },
        steps: [
          { step_id: 1, source: "user", message: `Use warning for ${id}.` },
          {
            step_id: 2,
            source: "agent",
            message: confirmation
              ? `Use warning for ${id}, correct?`
              : `Which level should ${id} use?`,
          },
        ],
      }),
      source_file: "fixture.jsonl",
      source_line: 1,
      atif_provenance: createAtifProvenance(
        { file: "fixture.jsonl", jsonl_line: 1 },
        "$.atif",
        "ATIF-v1.8",
      ),
    });
    const inputs = [
      makeInput("train-positive-a", "train", false),
      makeInput("train-positive-b", "train", false),
      makeInput("train-positive-c", "train", false),
      makeInput("train-confirmation", "train", true),
      makeInput("validation-positive-a", "validation", false),
      makeInput("validation-positive-b", "validation", false),
      makeInput("validation-positive-c", "validation", false),
      makeInput("validation-confirmation", "validation", true),
    ];
    const groundTruth = Object.fromEntries(inputs.map(input => [
      input.id,
      {
        [source.id]: input.id.endsWith("confirmation")
          ? { state: "completed", observed: false }
          : {
              state: "completed",
              observed: true,
              occurrences: [{
                evidence: [{ role: "step", path: "$.steps[1]" }],
              }],
            },
      },
    ]));
    const improvedInstruction =
      "Mark observed only when the agent re-asks for supplied information. " +
      "Do not count confirmation questions.";
    const complete = vi.fn(async (system: string, user: string) => {
      if (user.includes("Target Id:")) {
        return {
          content:
            "Feedback Summary: The naive instruction creates false positives for confirmation questions.",
        };
      }
      if (user.includes("Component Key:")) {
        return { content: `New Value: ${improvedInstruction}` };
      }
      const confirmation = user.includes(", correct?");
      const improved = system.includes("Do not count confirmation questions");
      const observed = confirmation ? !improved : true;
      return {
        content: `Observation: ${JSON.stringify(observed
          ? {
              state: "completed",
              observed: true,
              occurrences: [{
                evidence: [{ role: "step", path: "$.steps[1]" }],
              }],
            }
          : { state: "completed", observed: false })}`,
      };
    });
    const ai = copilotAI({ complete, close: async () => { } }, "mock");
    const progress: Array<{ phase: string; message: string }> = [];

    const optimized = await optimizePromptElement(
      taxonomy,
      source.id,
      inputs,
      groundTruth,
      ai,
      ai,
      "mock",
      16,
      event => progress.push(event),
    );

    expect(optimized.element.implementation.prompt).toBe(improvedInstruction);
    expect(optimized.manifest.metrics.best_score).toBe(1);
    expect(optimized.manifest.source_element_sha256)
      .not.toBe(optimized.manifest.optimized_element_sha256);
    const finalValidation = optimized.manifest.metric_trace
      .filter(row => row.split === "validation")
      .slice(-4);
    expect(finalValidation.map(row => row.input_id).sort()).toEqual([
      "validation-confirmation",
      "validation-positive-a",
      "validation-positive-b",
      "validation-positive-c",
    ]);
    expect(finalValidation.every(row => row.score === 1)).toBe(true);
    expect(progress).toContainEqual(expect.objectContaining({
      phase: "optimizing",
      message: expect.stringContaining("candidate changed"),
    }));
    expect(complete.mock.calls.some(([, user]) =>
      user.includes("false positives for confirmation")
    )).toBe(true);
  });

  it("publishes provenance without demos, examples, or trajectory bodies", async () => {
    const taxonomy = await neutralTaxonomy();
    const element = taxonomy.elementById.get("test-observation")!;
    const manifest = {
      schema_version: OPTIMIZATION_MANIFEST_VERSION,
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
      source_element_sha256: semanticHash(element),
      optimized_element_sha256: semanticHash({ ...element, prompt: "better" }),
      settings: { maxMetricCalls: 4, seed: 42, bootstrap: false },
      transport_settings: {
        reasoning_effort: "low",
        sampling: "sdk-managed",
        ax_sampling_hints_applied: false,
      },
      metrics: {
        best_score: 1,
        metric_calls: 2,
        total_rounds: 1,
        converged: true,
        stop_reason: "converged",
        optimization_time_ms: 10,
      },
      metric_trace: [],
    };
    expect(optimizationManifestSchema.parse(manifest)).toEqual(manifest);
    expect(JSON.stringify(manifest)).not.toContain("trajectory_context");
    expect(JSON.stringify(manifest)).not.toContain('"demos"');
    expect(JSON.stringify(manifest)).not.toContain('"examples"');
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
    )).not.toBe(manifest.contract_hash);
    expect(promptContractHash(
      taxonomy,
      {
        ...element,
        preconditions: {
          ...element.preconditions,
          requires_task: !element.preconditions.requires_task,
        },
      },
    )).not.toBe(manifest.contract_hash);
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
