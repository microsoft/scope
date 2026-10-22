// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { buildGroupingPipeline } from "./grouping.js";

describe("buildGroupingPipeline", () => {
  it("returns 4 pipeline stages for task grouping", () => {
    const pipeline = buildGroupingPipeline("task");
    expect(pipeline).toHaveLength(4);
    expect(pipeline[0]).toHaveProperty("$addFields");
    expect(pipeline[1]).toHaveProperty("$group");
    expect(pipeline[2]).toHaveProperty("$project");
    expect(pipeline[3]).toHaveProperty("$sort");
  });

  it("returns 4 pipeline stages for experimentId grouping", () => {
    const pipeline = buildGroupingPipeline("experimentId");
    expect(pipeline).toHaveLength(4);
  });

  it("preserves submissionId grouping", () => {
    const pipeline = buildGroupingPipeline("submissionId");
    expect(pipeline).toHaveLength(4);
    expect(
      (pipeline[0].$addFields as Record<string, unknown>)._groupKey,
    ).toBeDefined();
  });

  it("$sort stage orders by key ascending", () => {
    const pipeline = buildGroupingPipeline("task");
    expect(pipeline[3]).toEqual({ $sort: { key: 1 } });
  });

  it("groups by taskPromptId for task grouping", () => {
    const pipeline = buildGroupingPipeline("task");
    const addFields = pipeline[0].$addFields as Record<string, unknown>;
    // `task` groups purely by the always-present taskPromptId — no raw-text
    // fallback, so the server key always matches the client member-fetch filter.
    expect(addFields._groupKey).toBe("$taskPromptId");
  });

  it("groups by experimentId for experimentId grouping", () => {
    const pipeline = buildGroupingPipeline("experimentId");
    const addFields = pipeline[0].$addFields as Record<string, unknown>;
    expect(addFields._groupKey).toBeDefined();
  });

  it("$group stage uses _groupKey as _id", () => {
    const pipeline = buildGroupingPipeline("task");
    const group = pipeline[1].$group as Record<string, unknown>;
    expect(group._id).toBe("$_groupKey");
  });

  it("$group stage accumulates count and stat arrays", () => {
    const pipeline = buildGroupingPipeline("task");
    const group = pipeline[1].$group as Record<string, unknown>;
    expect(group.count).toEqual({ $sum: 1 });
    expect(group._turnCounts).toBeDefined();
    expect(group._durations).toBeDefined();
    expect(group._promptTokensList).toBeDefined();
    expect(group._completionTokensList).toBeDefined();
  });

  it("$group stage accumulates status and outcome counts", () => {
    const pipeline = buildGroupingPipeline("task");
    const group = pipeline[1].$group as Record<string, unknown>;
    expect(group._statusPending).toBeDefined();
    expect(group._statusProcessing).toBeDefined();
    expect(group._statusDone).toBeDefined();
    expect(group._outcomeSucceeded).toBeDefined();
    expect(group._outcomeFailed).toBeDefined();
    expect(group._outcomeFinished).toBeDefined();
  });

  it("$group stage collects distinct values for uniform detection", () => {
    const pipeline = buildGroupingPipeline("task");
    const group = pipeline[1].$group as Record<string, unknown>;
    expect(group._workerTypes).toBeDefined();
    expect(group._models).toBeDefined();
    expect(group._reasoningEfforts).toBeDefined();
    expect(group._agentVersions).toBeDefined();
    expect(group._platforms).toBeDefined();
    expect(group._statuses).toBeDefined();
    expect(group._submissionIds).toBeDefined();
    expect(group._experimentIds).toBeDefined();
    expect(group._tasks).toBeDefined();
    expect(group._mcpKeys).toBeDefined();
    expect(group._skillKeys).toBeDefined();
  });

  it("$group stage collects run IDs", () => {
    const pipeline = buildGroupingPipeline("task");
    const group = pipeline[1].$group as Record<string, unknown>;
    expect(group._runIds).toEqual({ $push: "$_id" });
  });

  it("$project stage outputs key, label, runIds, aggregates, uniform", () => {
    const pipeline = buildGroupingPipeline("task");
    const project = (pipeline[2] as { $project: Record<string, unknown> }).$project;
    expect(project._id).toBe(0);
    expect(project.key).toBeDefined();
    expect(project.runIds).toBe("$_runIds");
    expect(project.label).toBeDefined();
    expect(project.aggregates).toBeDefined();
    expect(project.uniform).toBeDefined();
  });

  it("$project aggregates include statusCounts and outcomeCounts", () => {
    const pipeline = buildGroupingPipeline("task");
    const project = pipeline[2].$project as Record<string, unknown>;
    const aggregates = project.aggregates as Record<string, unknown>;
    expect(aggregates.statusCounts).toEqual({ pending: "$_statusPending", queued: "$_statusQueued", processing: "$_statusProcessing", paused: "$_statusPaused", done: "$_statusDone" });
    expect(aggregates.outcomeCounts).toEqual({ succeeded: "$_outcomeSucceeded", failed: "$_outcomeFailed", finished: "$_outcomeFinished" });
  });

  it("$project uniform includes reasoningEffort field", () => {
    const pipeline = buildGroupingPipeline("task");
    const project = (pipeline[2] as { $project: Record<string, unknown> }).$project;
    const uniform = project.uniform as Record<string, unknown>;
    expect(uniform.reasoningEffort).toBeDefined();
  });
});
