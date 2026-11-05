// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import type { EvaluationInput } from "taxonomy-engine/evaluation-inputs";
import {
  createAtifProvenance,
  createHandlerRegistry,
  loadTaxonomy,
} from "taxonomy-engine";
import {
  planEvaluationJobs,
  runEvaluationJobs,
  summarizeEvaluationOutcomes,
} from "./evaluation-jobs.js";

async function taxonomy() {
  return loadTaxonomy(
    new URL(
      "../../../packages/taxonomy-engine/fixtures/test-taxonomy.yaml",
      import.meta.url,
    ).pathname,
    { handlers: createHandlerRegistry() },
  );
}

function input(id: string, elements: string[]): EvaluationInput {
  return {
    id,
    family: `family-${id}`,
    originating_run: `run-${id}`,
    split: "test",
    provenance: "scheduler fixture",
    elements,
    source_file: `${id}-inputs.jsonl`,
    source_line: 1,
    atif_provenance: createAtifProvenance(
      { file: "fixture.jsonl", jsonl_line: 1 },
      "$.atif",
      "ATIF-v1.8",
    ),
    atif: {
      schema_version: "ATIF-v1.8",
      session_id: `session-${id}`,
      agent: { name: "fixture", version: "1.0.0" },
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
}

describe("evaluation job scheduler", () => {
  it("plans stable sample/input/element sequence and selection", async () => {
    const loaded = await taxonomy();
    const inputs = [
      input("a", ["test-observation", "discovery-required"]),
      input("b", ["test-observation"]),
    ];
    expect(planEvaluationJobs(inputs, loaded, 2).map(job => [
      job.sequence,
      job.sample,
      job.input.id,
      job.element_id,
    ])).toEqual([
      [0, 0, "a", "test-observation"],
      [1, 0, "a", "discovery-required"],
      [2, 0, "b", "test-observation"],
      [3, 1, "a", "test-observation"],
      [4, 1, "a", "discovery-required"],
      [5, 1, "b", "test-observation"],
    ]);
    expect(planEvaluationJobs(
      inputs.filter(candidate =>
        candidate.elements.includes("test-observation")
      ),
      loaded,
      1,
      "test-observation",
    ).map(job => job.element_id)).toEqual([
      "test-observation",
      "test-observation",
    ]);
  });

  it("reaches but never exceeds the configured concurrency and keeps order", async () => {
    const loaded = await taxonomy();
    const jobs = planEvaluationJobs(
      Array.from({ length: 6 }, (_, index) =>
        input(String(index), ["test-observation"])
      ),
      loaded,
      1,
    );
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const execution = runEvaluationJobs(jobs, 3, async job => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active--;
      return `result-${job.sequence}`;
    });

    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases.splice(0, 3).forEach(release => release());
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases.splice(0, 3).forEach(release => release());
    const outcomes = await execution;

    expect(maximum).toBe(3);
    expect(outcomes.map(outcome => outcome.value)).toEqual([
      "result-0",
      "result-1",
      "result-2",
      "result-3",
      "result-4",
      "result-5",
    ]);
  });

  it("continues after failures and stops scheduling after cancellation", async () => {
    const loaded = await taxonomy();
    const jobs = planEvaluationJobs(
      Array.from({ length: 4 }, (_, index) =>
        input(String(index), ["test-observation"])
      ),
      loaded,
      1,
    );
    const outcomes = await runEvaluationJobs(jobs, 2, async job => {
      if (job.sequence === 1) throw new Error("reviewed failure");
      return job.sequence;
    });
    expect(outcomes.map(outcome => outcome.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);

    const controller = new AbortController();
    const starts: number[] = [];
    const cancelled = runEvaluationJobs(
      jobs,
      1,
      async job => {
        starts.push(job.sequence);
        controller.abort();
        throw new Error("cancelled");
      },
      {},
      controller.signal,
    );
    expect((await cancelled).map(outcome => outcome.status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(starts).toEqual([0]);
  });

  it("rejects invalid concurrency", async () => {
    await expect(runEvaluationJobs([], 0, async () => undefined))
      .rejects.toThrow("--concurrency must be 1..16");
    await expect(runEvaluationJobs([], 17, async () => undefined))
      .rejects.toThrow("--concurrency must be 1..16");
  });

  it("counts element-job outcomes even when one input has multiple elements", async () => {
    const loaded = await taxonomy();
    const planned = planEvaluationJobs([
      input("multi", ["test-observation", "discovery-required"]),
      input("single", ["test-observation"]),
    ], loaded, 1);
    const outcomes = await runEvaluationJobs(planned, 2, async job => ({
      failed: job.element_id === "discovery-required",
      cancelled: false,
    }));

    expect(summarizeEvaluationOutcomes(outcomes)).toEqual({
      passed: 2,
      failed: 1,
      cancelled: 0,
      total: 3,
    });
  });
});
