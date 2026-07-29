// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Document } from "mongodb";
import type { GroupByKey, RunGroup, AggregateStats, GroupUniformValues } from "@scope/core";

/**
 * Build a MongoDB aggregation pipeline that groups runs and computes
 * per-group aggregates (count, stats on turns/duration/tokens) and
 * uniform-value detection.
 *
 * The pipeline is appended after a $match stage with the caller's filter.
 */
export function buildGroupingPipeline(
  groupBy: "task" | "submissionId" | "profile",
): Document[] {
  const groupField =
    groupBy === "task" ? "$taskPromptId" : groupBy === "profile" ? "$profileId" : "$submissionId";
  const fallbackGroupField =
    groupBy === "task" ? "$scenario.task" : groupBy === "profile" ? { $literal: "no-profile" } : { $literal: "no-submission" };

  return [
    // 1. Compute per-run derived values
    {
      $addFields: {
        _groupKey: { $ifNull: [groupField, fallbackGroupField] },
        _turnCount: { $cond: { if: { $isArray: "$run.turns" }, then: { $size: "$run.turns" }, else: null } },
        _duration: {
          $cond: {
            if: { $and: [{ $isArray: "$run.turns" }, { $gt: [{ $size: "$run.turns" }, 0] }] },
            then: {
              $reduce: {
                input: "$run.turns",
                initialValue: 0,
                in: { $add: ["$$value", { $ifNull: ["$$this.durationMs", 0] }] },
              },
            },
            else: null,
          },
        },
        _promptTokens: {
          $cond: {
            if: "$run.tokenUsage",
            then: "$run.tokenUsage.promptTokens",
            else: {
              $cond: {
                if: { $and: [{ $isArray: "$run.turns" }, { $gt: [{ $size: { $filter: { input: { $ifNull: ["$run.turns", []] }, cond: { $ne: ["$$this.tokenUsage", null] } } } }, 0] }] },
                then: {
                  $reduce: {
                    input: "$run.turns",
                    initialValue: 0,
                    in: { $add: ["$$value", { $ifNull: ["$$this.tokenUsage.promptTokens", 0] }] },
                  },
                },
                else: null,
              },
            },
          },
        },
        _completionTokens: {
          $cond: {
            if: "$run.tokenUsage",
            then: "$run.tokenUsage.completionTokens",
            else: {
              $cond: {
                if: { $and: [{ $isArray: "$run.turns" }, { $gt: [{ $size: { $filter: { input: { $ifNull: ["$run.turns", []] }, cond: { $ne: ["$$this.tokenUsage", null] } } } }, 0] }] },
                then: {
                  $reduce: {
                    input: "$run.turns",
                    initialValue: 0,
                    in: { $add: ["$$value", { $ifNull: ["$$this.tokenUsage.completionTokens", 0] }] },
                  },
                },
                else: null,
              },
            },
          },
        },
        _llmCallCount: { $cond: { if: { $isNumber: "$run.aiCallCount" }, then: "$run.aiCallCount", else: null } },
        // Sorted-joined array keys for uniform comparison
        _mcpKey: {
          $reduce: {
            input: { $sortArray: { input: { $ifNull: ["$mcpServers", []] }, sortBy: 1 } },
            initialValue: "",
            in: { $concat: ["$$value", { $cond: { if: { $eq: ["$$value", ""] }, then: "", else: "," } }, "$$this"] },
          },
        },
        _skillKey: {
          $reduce: {
            input: { $sortArray: { input: { $ifNull: ["$skillRevisions", []] }, sortBy: 1 } },
            initialValue: "",
            in: { $concat: ["$$value", { $cond: { if: { $eq: ["$$value", ""] }, then: "", else: "," } }, "$$this"] },
          },
        },
        _extensionKey: {
          $reduce: {
            input: { $sortArray: { input: { $ifNull: ["$extensions", []] }, sortBy: 1 } },
            initialValue: "",
            in: { $concat: ["$$value", { $cond: { if: { $eq: ["$$value", ""] }, then: "", else: "," } }, "$$this"] },
          },
        },
      },
    },
    // 2. Group and accumulate per-run values
    {
      $group: {
        _id: "$_groupKey",
        count: { $sum: 1 },
        // Collect run IDs for report summaries and bulk actions
        _runIds: { $push: "$_id" },
        // Label: take first task name for display
        _firstTask: { $first: "$scenario.task" },
        // Push arrays for stats computation
        _turnCounts: { $push: "$_turnCount" },
        _durations: { $push: "$_duration" },
        _promptTokensList: { $push: "$_promptTokens" },
        _completionTokensList: { $push: "$_completionTokens" },
        _llmCallCounts: { $push: "$_llmCallCount" },
        // Uniform detection: collect distinct values
        _workerTypes: { $addToSet: "$workerType" },
        _models: { $addToSet: { $ifNull: ["$model", ""] } },
        _agentVersions: { $addToSet: { $ifNull: ["$agentVersion", ""] } },
        _platforms: { $addToSet: { $ifNull: ["$run.os.platform", ""] } },
        _statuses: { $addToSet: "$run.status" },
        _submissionIds: { $addToSet: { $ifNull: ["$submissionId", ""] } },
        _tasks: { $addToSet: { $ifNull: ["$scenario.task", ""] } },
        _mcpKeys: { $addToSet: "$_mcpKey" },
        _skillKeys: { $addToSet: "$_skillKey" },
        _extensionKeys: { $addToSet: "$_extensionKey" },
        // Status/outcome distribution counts
        _statusPending: { $sum: { $cond: [{ $eq: ["$run.status", "pending"] }, 1, 0] } },
        _statusQueued: { $sum: { $cond: [{ $eq: ["$run.status", "queued"] }, 1, 0] } },
        _statusProcessing: { $sum: { $cond: [{ $eq: ["$run.status", "processing"] }, 1, 0] } },
        _statusPaused: { $sum: { $cond: [{ $eq: ["$run.status", "paused"] }, 1, 0] } },
        _statusDone: { $sum: { $cond: [{ $eq: ["$run.status", "done"] }, 1, 0] } },
        _outcomeSucceeded: { $sum: { $cond: [{ $eq: ["$run.outcome", "succeeded"] }, 1, 0] } },
        _outcomeFailed: { $sum: { $cond: [{ $eq: ["$run.outcome", "failed"] }, 1, 0] } },
        _outcomeFinished: { $sum: { $cond: [{ $eq: ["$run.outcome", "finished"] }, 1, 0] } },
        // Keep first run's array values for uniform fields
        _firstMcpServers: { $first: "$mcpServers" },
        _firstSkillRevisions: { $first: "$skillRevisions" },
        _firstExtensions: { $first: "$extensions" },
      },
    },
    // 3. Project into final shape
    {
      $project: {
        _id: 0,
        key: "$_id",
        runIds: "$_runIds",
        label: {
          $switch: {
            branches: [
              { case: { $eq: ["$_id", "no-submission"] }, then: "No submission ID" },
              { case: { $eq: ["$_id", "no-profile"] }, then: "No profile" },
            ],
            default: { $ifNull: ["$_firstTask", "$_id"] },
          },
        },
        aggregates: {
          count: "$count",
          turns: { $let: { vars: { vals: { $filter: { input: "$_turnCounts", cond: { $ne: ["$$this", null] } } } }, in: { $cond: { if: { $eq: [{ $size: "$$vals" }, 0] }, then: null, else: { min: { $min: "$$vals" }, max: { $max: "$$vals" }, mean: { $avg: "$$vals" }, stdDev: { $cond: { if: { $lte: [{ $size: "$$vals" }, 1] }, then: 0, else: { $sqrt: { $avg: { $map: { input: "$$vals", in: { $pow: [{ $subtract: ["$$this", { $avg: "$$vals" }] }, 2] } } } } } } } } } } } },
          duration: { $let: { vars: { vals: { $filter: { input: "$_durations", cond: { $and: [{ $ne: ["$$this", null] }, { $gt: ["$$this", 0] }] } } } }, in: { $cond: { if: { $eq: [{ $size: "$$vals" }, 0] }, then: null, else: { min: { $min: "$$vals" }, max: { $max: "$$vals" }, mean: { $avg: "$$vals" }, stdDev: { $cond: { if: { $lte: [{ $size: "$$vals" }, 1] }, then: 0, else: { $sqrt: { $avg: { $map: { input: "$$vals", in: { $pow: [{ $subtract: ["$$this", { $avg: "$$vals" }] }, 2] } } } } } } } } } } } },
          promptTokens: { $let: { vars: { vals: { $filter: { input: "$_promptTokensList", cond: { $ne: ["$$this", null] } } } }, in: { $cond: { if: { $eq: [{ $size: "$$vals" }, 0] }, then: null, else: { min: { $min: "$$vals" }, max: { $max: "$$vals" }, mean: { $avg: "$$vals" }, stdDev: { $cond: { if: { $lte: [{ $size: "$$vals" }, 1] }, then: 0, else: { $sqrt: { $avg: { $map: { input: "$$vals", in: { $pow: [{ $subtract: ["$$this", { $avg: "$$vals" }] }, 2] } } } } } } } } } } } },
          completionTokens: { $let: { vars: { vals: { $filter: { input: "$_completionTokensList", cond: { $ne: ["$$this", null] } } } }, in: { $cond: { if: { $eq: [{ $size: "$$vals" }, 0] }, then: null, else: { min: { $min: "$$vals" }, max: { $max: "$$vals" }, mean: { $avg: "$$vals" }, stdDev: { $cond: { if: { $lte: [{ $size: "$$vals" }, 1] }, then: 0, else: { $sqrt: { $avg: { $map: { input: "$$vals", in: { $pow: [{ $subtract: ["$$this", { $avg: "$$vals" }] }, 2] } } } } } } } } } } } },
          llmCalls: { $let: { vars: { vals: { $filter: { input: "$_llmCallCounts", cond: { $ne: ["$$this", null] } } } }, in: { $cond: { if: { $eq: [{ $size: "$$vals" }, 0] }, then: null, else: { min: { $min: "$$vals" }, max: { $max: "$$vals" }, mean: { $avg: "$$vals" }, stdDev: { $cond: { if: { $lte: [{ $size: "$$vals" }, 1] }, then: 0, else: { $sqrt: { $avg: { $map: { input: "$$vals", in: { $pow: [{ $subtract: ["$$this", { $avg: "$$vals" }] }, 2] } } } } } } } } } } } },
          statusCounts: { pending: "$_statusPending", queued: "$_statusQueued", processing: "$_statusProcessing", paused: "$_statusPaused", done: "$_statusDone" },
          outcomeCounts: { succeeded: "$_outcomeSucceeded", failed: "$_outcomeFailed", finished: "$_outcomeFinished" },
        },
        uniform: {
          workerType: { $cond: { if: { $eq: [{ $size: "$_workerTypes" }, 1] }, then: { $arrayElemAt: ["$_workerTypes", 0] }, else: "$$REMOVE" } },
          model: { $cond: { if: { $and: [{ $eq: [{ $size: "$_models" }, 1] }, { $ne: [{ $arrayElemAt: ["$_models", 0] }, ""] }] }, then: { $arrayElemAt: ["$_models", 0] }, else: "$$REMOVE" } },
          agentVersion: { $cond: { if: { $and: [{ $eq: [{ $size: "$_agentVersions" }, 1] }, { $ne: [{ $arrayElemAt: ["$_agentVersions", 0] }, ""] }] }, then: { $arrayElemAt: ["$_agentVersions", 0] }, else: "$$REMOVE" } },
          platform: { $cond: { if: { $and: [{ $eq: [{ $size: "$_platforms" }, 1] }, { $ne: [{ $arrayElemAt: ["$_platforms", 0] }, ""] }] }, then: { $arrayElemAt: ["$_platforms", 0] }, else: "$$REMOVE" } },
          status: { $cond: { if: { $eq: [{ $size: "$_statuses" }, 1] }, then: { $arrayElemAt: ["$_statuses", 0] }, else: "$$REMOVE" } },
          submissionId: { $cond: { if: { $and: [{ $eq: [{ $size: "$_submissionIds" }, 1] }, { $ne: [{ $arrayElemAt: ["$_submissionIds", 0] }, ""] }] }, then: { $arrayElemAt: ["$_submissionIds", 0] }, else: "$$REMOVE" } },
          task: { $cond: { if: { $and: [{ $eq: [{ $size: "$_tasks" }, 1] }, { $ne: [{ $arrayElemAt: ["$_tasks", 0] }, ""] }] }, then: { $arrayElemAt: ["$_tasks", 0] }, else: "$$REMOVE" } },
          mcpServers: { $cond: { if: { $and: [{ $eq: [{ $size: "$_mcpKeys" }, 1] }, { $ne: [{ $arrayElemAt: ["$_mcpKeys", 0] }, ""] }] }, then: "$_firstMcpServers", else: "$$REMOVE" } },
          skillRevisions: { $cond: { if: { $and: [{ $eq: [{ $size: "$_skillKeys" }, 1] }, { $ne: [{ $arrayElemAt: ["$_skillKeys", 0] }, ""] }] }, then: "$_firstSkillRevisions", else: "$$REMOVE" } },
          extensions: { $cond: { if: { $and: [{ $eq: [{ $size: "$_extensionKeys" }, 1] }, { $ne: [{ $arrayElemAt: ["$_extensionKeys", 0] }, ""] }] }, then: "$_firstExtensions", else: "$$REMOVE" } },
        },
      },
    },
    // 4. Sort by grouping key for deterministic ordering
    { $sort: { key: 1 } },
  ];
}
