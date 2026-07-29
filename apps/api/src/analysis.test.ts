// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { computeAnalysis, type AnalyzableRun } from "./analysis.js";
import { computeTaskPromptId } from "@scope/platform";

describe("computeAnalysis – taskPromptId grouping", () => {
  const kValues = [1, 5];

  function makeRun(overrides: Partial<AnalyzableRun> & { task: string; workerType: string }): AnalyzableRun {
    const { task, workerType, ...rest } = overrides;
    return {
      scenario: { task, criteria: ["c1"] },
      workerType,
      status: "done",
      outcome: "succeeded",
      turns: [{ iteration: 1, passed: true, criteriaResults: [] }],
      ...rest,
    };
  }

  it("groups runs by taskPromptId when present", () => {
    const tpId = computeTaskPromptId("Create an API");
    const runs: AnalyzableRun[] = [
      makeRun({ task: "Create an API", workerType: "agent-a", taskPromptId: tpId }),
      makeRun({ task: "Create an API", workerType: "agent-a", taskPromptId: tpId }),
    ];

    const result = computeAnalysis(runs, kValues);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].taskPromptId).toBe(tpId);
    expect(result.groups[0].task).toBe("Create an API");
    expect(result.groups[0].total).toBe(2);
  });

  it("falls back to computing ID from task text for legacy runs without taskPromptId", () => {
    const runs: AnalyzableRun[] = [
      makeRun({ task: "Build a CLI", workerType: "agent-a" }), // no taskPromptId
      makeRun({ task: "Build a CLI", workerType: "agent-a" }), // no taskPromptId
    ];

    const result = computeAnalysis(runs, kValues);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].taskPromptId).toBe(computeTaskPromptId("Build a CLI"));
  });

  it("groups mixed runs (with and without taskPromptId) by same computed ID", () => {
    const tpId = computeTaskPromptId("Deploy to Azure");
    const runs: AnalyzableRun[] = [
      makeRun({ task: "Deploy to Azure", workerType: "agent-a", taskPromptId: tpId }),
      makeRun({ task: "Deploy to Azure", workerType: "agent-a" }), // legacy — no taskPromptId
    ];

    const result = computeAnalysis(runs, kValues);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].total).toBe(2);
  });

  it("separates different tasks into different groups", () => {
    const runs: AnalyzableRun[] = [
      makeRun({ task: "Task A", workerType: "agent-a", taskPromptId: computeTaskPromptId("Task A") }),
      makeRun({ task: "Task B", workerType: "agent-a", taskPromptId: computeTaskPromptId("Task B") }),
    ];

    const result = computeAnalysis(runs, kValues);
    expect(result.groups).toHaveLength(2);
  });

  it("separates same task with different workers into different groups", () => {
    const tpId = computeTaskPromptId("Same task");
    const runs: AnalyzableRun[] = [
      makeRun({ task: "Same task", workerType: "agent-a", taskPromptId: tpId }),
      makeRun({ task: "Same task", workerType: "agent-b", taskPromptId: tpId }),
    ];

    const result = computeAnalysis(runs, kValues);
    expect(result.groups).toHaveLength(2);
    const workers = result.groups.map((g) => g.workerType).sort();
    expect(workers).toEqual(["agent-a", "agent-b"]);
  });
});

describe("computeAnalysis – durationStats", () => {
  const kValues = [1];

  function makeRunWithDurations(
    durations: (number | undefined)[],
    passed: boolean
  ): AnalyzableRun {
    return {
      scenario: { task: "Task X", criteria: ["c1"] },
      taskPromptId: computeTaskPromptId("Task X"),
      workerType: "agent-a",
      status: "done",
      outcome: "succeeded",
      turns: durations.map((d, i) => ({
        iteration: i + 1,
        passed: i === durations.length - 1 ? passed : false,
        criteriaResults: [],
        durationMs: d,
      })),
    };
  }

  it("computes durationStats as total run duration across passed runs", () => {
    const runs = [
      makeRunWithDurations([10000, 20000], true),   // total = 30000
      makeRunWithDurations([15000], true),           // total = 15000
    ];
    const result = computeAnalysis(runs, kValues);
    expect(result.groups).toHaveLength(1);
    const ds = result.groups[0].durationStats;
    expect(ds).not.toBeNull();
    // Run totals: 30000, 15000 → mean = 22500
    expect(ds!.mean).toBe(22500);
    expect(ds!.min).toBe(15000);
    expect(ds!.max).toBe(30000);
  });

  it("returns null durationStats when no passed runs", () => {
    const runs = [makeRunWithDurations([10000], false)];
    const result = computeAnalysis(runs, kValues);
    expect(result.groups[0].durationStats).toBeNull();
  });

  it("returns null durationStats when passed runs have no durationMs", () => {
    const runs = [makeRunWithDurations([undefined], true)];
    const result = computeAnalysis(runs, kValues);
    expect(result.groups[0].durationStats).toBeNull();
  });
});
