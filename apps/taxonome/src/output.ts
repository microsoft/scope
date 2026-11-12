// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Evaluation } from "taxonomy-engine";
import type { EvaluationOutcomeSummary } from "./evaluation-jobs.js";

/** Minimal taxonomy identity shown in human output. */
export interface TaxonomyIdentity {
  /** Authored taxonomy ID. */
  id: string;
  /** Authored taxonomy version. */
  version: string;
}

/** One JSON-compatible eval result retained by `--json`. */
export interface EvaluationResultRow {
  /** Stable curated input ID. */
  input_id: string;
  /** Source JSONL filename. */
  input_file: string;
  /** Input split selected for this execution. */
  split: string;
  /** Zero-based repetition index retained for compatibility. */
  sample: number;
  /** Element evaluations produced for the input. */
  results: Evaluation[];
  /** Fixed-assertion failures; empty means PASS. */
  errors: string[];
  /** End-to-end input latency in milliseconds. */
  latency_ms: number;
}

/** Human-facing run identity derived from Scope ATIF metadata. */
export interface RunIdentity {
  /** Stable run/session ID. */
  id: string;
  /** Scenario identity and optional task text. */
  scenario: { id: string; label: string; task?: string };
  /** Profile identity. */
  profile: { id: string; label: string };
}

/** One optimized element summary without trajectory or prompt payloads. */
export interface OptimizationHumanResult {
  element_id: string;
  train_ids: string[];
  validation_ids: string[];
  settings: { maxMetricCalls: number; bootstrap: false };
  metrics: {
    best_score: number;
    metric_calls: number;
    total_rounds: number;
    converged: boolean;
    stop_reason?: string;
    pareto_front_size?: number;
  };
  yaml_path: string;
  manifest_path: string;
}

/** Inputs required for one human eval summary. */
export interface EvaluationHumanOptions {
  /** Loaded taxonomy identity. */
  taxonomy: TaxonomyIdentity;
  /** Matched JSONL input files. */
  input_files: string[];
  /** Matched ground-truth files. */
  ground_truth_files: string[];
  /** Selected dataset split. */
  split: string;
  /** Distinct selected inputs before repetitions. */
  inputs: number;
  /** Requested executions per selected input. */
  repetitions: number;
  /** Total wall-clock evaluation duration. */
  elapsed_ms: number;
  /** Selected element labels, IDs, and implementations. */
  elements: Array<{
    id: string;
    label: string;
    implementation: "prompt" | "deterministic";
  }>;
  /** Standard optimized element YAML override paths. */
  element_overrides: string[];
  /** Executed input rows. */
  rows: readonly EvaluationResultRow[];
}

/** Narrows one untrusted result/serialized-program object. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Formats one grounded occurrence without dumping unrelated payload fields. */
function occurrenceSummary(value: unknown): string {
  const occurrence = record(value);
  if (!occurrence) return "invalid occurrence";
  if (!Array.isArray(occurrence.evidence)) return "no grounded references";
  const references = occurrence.evidence.flatMap(reference => {
    const item = record(reference);
    return typeof item?.role === "string" && typeof item.path === "string"
      ? [`${item.role}=${item.path}`]
      : [];
  });
  return references.length ? references.join("; ") : "no grounded references";
}

/** Returns engine-owned runtime/configuration errors. */
export function evaluationRuntimeErrors(results: readonly Evaluation[]): string[] {
  return results.flatMap(evaluation => evaluation.status === "failed"
    ? [
      `${evaluation.element.label} (${evaluation.element.id}): ` +
      `${evaluation.error.code}: ${evaluation.error.message}`,
    ]
    : []);
}

/** Renders one run without raw prompts, tokens, or full JSON envelopes. */
export function renderRunHuman(
  taxonomy: TaxonomyIdentity,
  run: RunIdentity,
  results: readonly Evaluation[],
): string {
  const lines = [
    `Taxonomy: ${taxonomy.id} v${taxonomy.version}`,
    `Run: ${run.id}`,
    `Scenario: ${run.scenario.label} (${run.scenario.id})`,
    `Profile: ${run.profile.label} (${run.profile.id})`,
    "Results:",
  ];

  for (const evaluation of results) {
    if (evaluation.status === "failed") {
      lines.push(
        `- ${evaluation.element.label} (${evaluation.element.id}): ` +
        `${evaluation.implementation.type}; failed=${evaluation.error.code}`,
        `  Error: ${evaluation.error.message}`,
      );
      continue;
    }
    const result = record(evaluation.result);
    const state = typeof result?.state === "string" ? result.state : "unknown";
    const strategy = evaluation.implementation.handler
      ? `${evaluation.implementation.type} (${evaluation.implementation.handler})`
      : evaluation.implementation.type;
    lines.push(
      `- ${evaluation.element.label} (${evaluation.element.id}): ` +
      `${strategy}; state=${state}`,
    );
    if (typeof result?.observed === "boolean") {
      lines.push(`  Observed: ${result.observed ? "yes" : "no"}`);
    }
    const occurrences = Array.isArray(result?.occurrences)
      ? result.occurrences
      : [];
    if (typeof result?.observed === "boolean" || occurrences.length) {
      lines.push(`  Occurrences: ${occurrences.length}`);
    }
    if (occurrences.length) {
      occurrences.forEach((occurrence, index) => {
        lines.push(`  ${index + 1}. ${occurrenceSummary(occurrence)}`);
      });
    }
    const detail = typeof result?.reason === "string"
        ? `Reason: ${result.reason}`
        : undefined;
    if (detail) lines.push(`  ${detail}`);
    if ((evaluation.implementation.attempts?.length ?? 0) > 1) {
      lines.push("  Repaired: yes");
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Renders eval counts, configuration, inputs, and actionable failures. */
export function renderEvalHuman(options: EvaluationHumanOptions): string {
  const passed = options.rows.filter(row => row.errors.length === 0).length;
  const failed = options.rows.length - passed;
  const runtimeFailures = options.rows.filter(row =>
    evaluationRuntimeErrors(row.results).length > 0
  ).length;
  const passRate = options.rows.length
    ? `${((passed / options.rows.length) * 100).toFixed(1)}%`
    : "0.0%";
  const lines = [
    `Taxonomy: ${options.taxonomy.id} v${options.taxonomy.version}`,
    `Elements: ${options.elements.map(element =>
      `${element.label} (${element.id}; ${
        element.implementation === "prompt" ? "Prompt" : "Code/Deterministic"
      })`
    ).join(", ")}`,
    `Input files: ${options.input_files.join(", ")}`,
    `Ground truth: ${options.ground_truth_files.join(", ")}`,
    `Split: ${options.split}`,
    `Configuration: ${options.element_overrides.length
      ? `element overrides ${options.element_overrides.join(", ")}`
      : "original YAML prompt"}`,
    `Inputs: ${options.inputs}; repetitions: ${options.repetitions}; executions: ${options.rows.length}`,
    `Result: ${passed} passed; ${failed} failed; pass rate ${passRate}`,
    `Elapsed: ${(options.elapsed_ms / 1000).toFixed(2)}s`,
    "Note: expected false, indeterminate, inapplicable, and authoritative preflight results can PASS when they match ground truth.",
  ];

  if (runtimeFailures) {
    lines.push(
      `Runtime/configuration failures: ${runtimeFailures}. ` +
      "Do not interpret this run as detector quality until they are resolved.",
    );
  }

  lines.push("Inputs:");
  for (const row of options.rows) {
    const runtimeErrors = evaluationRuntimeErrors(row.results);
    const repaired = row.results.filter(evaluation =>
      evaluation.status === "succeeded" &&
      evaluation.implementation.attempts.length > 1
    );
    const status = row.errors.length ? "FAIL" : "PASS";
    lines.push(
      `- ${status} ${row.input_id} (${row.input_file}; sample ${row.sample + 1})`,
    );
    if (row.errors.length || runtimeErrors.length) {
      const details = [
        ...runtimeErrors.map(error => `runtime: ${error}`),
        ...row.errors.map(error => `assertion: ${error}`),
      ];
      for (const detail of [...new Set(details)]) {
        lines.push(`  - ${detail}`);
      }
    }
    if (repaired.length) {
      lines.push(
        `  - repaired: ${repaired.map(evaluation =>
          `${evaluation.element.label} (${evaluation.element.id})`
        ).join(", ")}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Renders the compact post-dashboard TTY result from element-job outcomes. */
export function renderEvalCompactHuman(
  summary: EvaluationOutcomeSummary,
  elapsedMs: number,
): string {
  const parts = [
    `${summary.passed} passed`,
    `${summary.failed} failed`,
    ...(summary.cancelled ? [`${summary.cancelled} cancelled`] : []),
    `${summary.total} evaluations`,
    `${(elapsedMs / 1000).toFixed(1)}s`,
  ];
  return `Result  ${parts.join(" • ")}\n`;
}

/** Renders optimizer facts without claiming an unmeasured improvement. */
export function renderOptimizeHuman(
  results: readonly OptimizationHumanResult[],
): string {
  const lines = [
    `Optimized elements: ${results.length}`,
    ...results.flatMap(result => [
      `- ${result.element_id}`,
      `  Train: ${result.train_ids.length}; Validation: ${result.validation_ids.length}`,
      `  Best score: ${result.metrics.best_score}; metric calls: ${result.metrics.metric_calls}/${result.settings.maxMetricCalls}`,
      `  Rounds: ${result.metrics.total_rounds}; converged: ${result.metrics.converged}`,
      `  Stop: ${result.metrics.stop_reason ?? "not reported"}` +
        `${result.metrics.pareto_front_size === undefined
          ? ""
          : `; Pareto frontier: ${result.metrics.pareto_front_size}`}`,
      `  YAML: ${result.yaml_path}`,
      `  Manifest: ${result.manifest_path}`,
    ]),
    "Bootstrap: disabled; no examples or complete ATIF trajectories were embedded.",
    "No before/after accuracy gain is inferred by this summary.",
    "",
  ];
  return lines.join("\n");
}
