// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { EvaluationInput } from "taxonomy-engine/evaluation-inputs";
import type { NormalizedTaxonomy } from "taxonomy-engine";

/** One stable sample/input/element evaluation unit. */
export interface EvaluationJob {
  /** Stable zero-based output sequence. */
  sequence: number;
  /** Zero-based repetition. */
  sample: number;
  /** Reviewed input. */
  input: EvaluationInput;
  /** Stable selected element ID. */
  element_id: string;
  /** Human-facing element label. */
  element_label: string;
  /** Whether the job can reach a model. */
  implementation: "prompt" | "deterministic";
}

/** Settled job result retained in stable sequence order. */
export interface EvaluationJobOutcome<Value> {
  /** Original stable job. */
  job: EvaluationJob;
  /** Worker slot that executed the job. */
  worker_id: number;
  /** Fulfilled, rejected, or cancelled before scheduling. */
  status: "fulfilled" | "rejected" | "cancelled";
  /** Successful execution value. */
  value?: Value;
  /** Rejected execution error. */
  error?: unknown;
}

/** Scheduler lifecycle hooks used by progress/dashboard rendering. */
export interface EvaluationJobHooks<Value> {
  /** Called immediately before a worker executes the job. */
  onStart?(job: EvaluationJob, workerId: number): void;
  /** Called after the outcome is stored. */
  onComplete?(outcome: EvaluationJobOutcome<Value>): void;
}

/** Evaluation-level counts derived from settled element jobs. */
export interface EvaluationOutcomeSummary {
  /** Successful element evaluations. */
  passed: number;
  /** Failed element evaluations excluding cancellation. */
  failed: number;
  /** Cancelled active or unscheduled evaluations. */
  cancelled: number;
  /** Total planned element evaluations. */
  total: number;
}

/** Flattens selected inputs into stable sample/input/element order. */
export function planEvaluationJobs(
  inputs: readonly EvaluationInput[],
  taxonomy: NormalizedTaxonomy,
  samples: number,
  selectedElement?: string,
): EvaluationJob[] {
  const jobs: EvaluationJob[] = [];
  for (let sample = 0; sample < samples; sample++) {
    for (const input of inputs) {
      const elementIds = selectedElement ? [selectedElement] : input.elements;
      for (const elementId of elementIds) {
        const element = taxonomy.elementById.get(elementId);
        if (!element) {
          throw new Error(`Input '${input.id}' selects unknown element '${elementId}'`);
        }
        jobs.push({
          sequence: jobs.length,
          sample,
          input,
          element_id: element.id,
          element_label: element.label,
          implementation: element.implementation.type,
        });
      }
    }
  }
  return jobs;
}

/**
 * Executes jobs through a bounded global pool while preserving output order.
 *
 * Scheduling stops after cancellation; active jobs receive the same signal.
 */
export async function runEvaluationJobs<Value>(
  jobs: readonly EvaluationJob[],
  concurrency: number,
  execute: (
    job: EvaluationJob,
    workerId: number,
    signal?: AbortSignal,
  ) => Promise<Value>,
  hooks: EvaluationJobHooks<Value> = {},
  signal?: AbortSignal,
): Promise<EvaluationJobOutcome<Value>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("--concurrency must be 1..16");
  }

  const outcomes: Array<EvaluationJobOutcome<Value> | undefined> =
    Array(jobs.length);
  let nextIndex = 0;

  /** Claims and executes jobs sequentially within one worker slot. */
  async function worker(workerId: number): Promise<void> {
    while (!signal?.aborted) {
      const index = nextIndex++;
      const job = jobs[index];
      if (!job) return;
      hooks.onStart?.(job, workerId);

      let outcome: EvaluationJobOutcome<Value>;
      try {
        const value = await execute(job, workerId, signal);
        outcome = {
          job,
          worker_id: workerId,
          status: "fulfilled",
          value,
        };
      } catch (error) {
        outcome = {
          job,
          worker_id: workerId,
          status: signal?.aborted ? "cancelled" : "rejected",
          error,
        };
      }
      outcomes[job.sequence] = outcome;
      hooks.onComplete?.(outcome);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, jobs.length) },
      (_, workerId) => worker(workerId),
    ),
  );

  for (const job of jobs) {
    outcomes[job.sequence] ??= {
      job,
      worker_id: -1,
      status: "cancelled",
      error: new Error("Evaluation cancelled before scheduling"),
    };
  }
  return outcomes as EvaluationJobOutcome<Value>[];
}

/** Summarizes job outcomes, including fulfilled values that report failure/cancel. */
export function summarizeEvaluationOutcomes<
  Value extends { failed?: boolean; cancelled?: boolean },
>(
  outcomes: readonly EvaluationJobOutcome<Value>[],
): EvaluationOutcomeSummary {
  let passed = 0;
  let failed = 0;
  let cancelled = 0;
  for (const outcome of outcomes) {
    const valueCancelled = outcome.status === "fulfilled" &&
      outcome.value?.cancelled === true;
    if (outcome.status === "cancelled" || valueCancelled) {
      cancelled++;
    } else if (
      outcome.status === "rejected" ||
      outcome.value?.failed === true
    ) {
      failed++;
    } else {
      passed++;
    }
  }
  return { passed, failed, cancelled, total: outcomes.length };
}
