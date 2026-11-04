// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import type { Evaluation } from "taxonomy-engine";
import {
  renderEvalHuman,
  renderEvalCompactHuman,
  renderOptimizeHuman,
  renderRunHuman,
  type EvaluationRow,
} from "./output.js";

const positive: Evaluation = {
  schema_version: "scope/taxonomy-evaluation/v1",
  taxonomy: { id: "example-taxonomy", version: "1.0.0", digest: "digest" },
  element: {
    id: "beh-timeout",
    label: "Timeout",
    category_id: "behavior-category-invocation",
  },
  implementation: {
    type: "deterministic",
    handler: "scope/timeout-v1",
    attempts: [{ attempt: 1, kind: "initial", outcome: "succeeded" }],
  },
  input: {
    normalization: "scope/taxonome-normalized-atif/v1",
    sha256: "a".repeat(64),
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
};

describe("Taxonome human output", () => {
  it("renders run state, strategy, observation, and grounded references", () => {
    const output = renderRunHuman(
      { id: "example-taxonomy", version: "1.0.0" },
      {
        id: "run-1",
        scenario: { id: "scenario-1", label: "Scenario" },
        profile: { id: "profile-1", label: "Profile" },
      },
      [positive],
    );

    expect(output).toContain("Timeout (beh-timeout): deterministic (scope/timeout-v1)");
    expect(output).toContain("Observed: yes");
    expect(output).toContain("call=$.steps[1].tool_calls[0]");
  });

  it("separates runtime failures from detector-quality counts", () => {
    const { result: _result, ...positiveBase } = positive;
    const runtimeError: Evaluation = {
      ...positiveBase,
      element: { id: "beh-skipped-invocation", label: "Skipped Invocation" },
      implementation: {
        type: "prompt",
        attempts: [{
          attempt: 1,
          kind: "initial",
          outcome: "execution_failed",
        }],
      },
      status: "failed",
      error: {
        code: "execution_failed",
        message: "Copilot SDK is not authenticated",
      },
    };
    const rows: EvaluationRow[] = [
      {
        input_id: "input-pass",
        input_file: "fixtures/prompt-inputs.jsonl",
        split: "test",
        sample: 0,
        results: [{ ...positive, result: { state: "completed", observed: false } }],
        errors: [],
        latency_ms: 1,
      },
      {
        input_id: "input-auth",
        input_file: "fixtures/prompt-inputs.jsonl",
        split: "test",
        sample: 0,
        results: [runtimeError],
        errors: ["Expected completed state"],
        latency_ms: 1,
      },
    ];

    const output = renderEvalHuman({
      taxonomy: { id: "example-taxonomy", version: "1.0.0" },
      input_files: ["fixtures/prompt-inputs.jsonl"],
      ground_truth_files: ["fixtures/prompt-ground-truth.json"],
      split: "test",
      inputs: 2,
      repetitions: 1,
      elapsed_ms: 1234,
      elements: [{
        id: "beh-skipped-invocation",
        label: "Skipped Invocation",
        implementation: "prompt",
      }],
      element_overrides: [],
      rows,
    });

    expect(output).toContain("1 passed; 1 failed; pass rate 50.0%");
    expect(output).toContain("Runtime/configuration failures: 1");
    expect(output).toContain("Do not interpret this run as detector quality");
    expect(output).toContain("runtime: Skipped Invocation");
    expect(output).toContain("expected false");
    expect(output).toContain("Elapsed: 1.23s");
    expect(renderEvalHuman({
      taxonomy: { id: "example-taxonomy", version: "1.0.0" },
      input_files: ["fixtures/prompt-inputs.jsonl"],
      ground_truth_files: ["fixtures/prompt-ground-truth.json"],
      split: "test",
      inputs: 2,
      repetitions: 1,
      elapsed_ms: 1234,
      elements: [{
        id: "beh-skipped-invocation",
        label: "Skipped Invocation",
        implementation: "prompt",
      }],
      element_overrides: ["optimized/beh-skipped-invocation.optimized.yaml"],
      rows,
    })).toContain(
      "Configuration: element overrides optimized/beh-skipped-invocation.optimized.yaml",
    );
  });

  it("summarizes optimized YAML without embedding examples", () => {
    const output = renderOptimizeHuman([{
      element_id: "beh-skipped-invocation",
      train_ids: ["train-1", "train-2"],
      validation_ids: ["validation-1"],
      settings: { maxMetricCalls: 12, bootstrap: false },
      metrics: {
        best_score: 1,
        metric_calls: 3,
        total_rounds: 2,
        converged: true,
        stop_reason: "converged",
      },
      yaml_path: "optimized/beh-skipped-invocation.optimized.yaml",
      manifest_path:
        "optimized/beh-skipped-invocation.optimization.manifest.json",
    }]);

    expect(output).toContain("metric calls: 3/12");
    expect(output).toContain("Stop: converged");
    expect(output).toContain("Bootstrap: disabled");
    expect(output).toContain("beh-skipped-invocation.optimized.yaml");
    expect(output).toContain("No before/after accuracy gain is inferred");
  });

  it("renders only evaluation-level counts for post-dashboard TTY output", () => {
    const output = renderEvalCompactHuman({
      passed: 2,
      failed: 1,
      cancelled: 1,
      total: 4,
    }, 4200);

    expect(output).toBe(
      "Result  2 passed • 1 failed • 1 cancelled • 4 evaluations • 4.2s\n",
    );
    expect(output).not.toContain("Input files:");
    expect(output).not.toContain("Ground truth:");
    expect(output).not.toContain("Inputs:");
  });
});
