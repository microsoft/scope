// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { ScenarioSchema, PersonaSchema } from "./scenario.js";

extendZodWithOpenApi(z);

export const TokenUsageSchema = z
  .object({
    promptTokens: z.number(),
    completionTokens: z.number(),
    totalTokens: z.number(),
  })
  .openapi("TokenUsage");

export const LogEventSchema = z
  .object({
    timestamp: z.string(),
    level: z.enum(["info", "warn", "error", "debug"]),
    source: z.string().optional(),
    message: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("LogEvent");

export const CriterionResultSchema = z
  .object({
    criterionId: z.string(),
    passed: z.boolean(),
    feedback: z.string(),
    evaluated: z.boolean(),
  })
  .openapi("CriterionResult");

export const ConversationTurnSchema = z
  .object({
    iteration: z.number(),
    codingAgentResponse: z.string().optional(),
    judgeFeedback: z.string(),
    snapshotUrl: z.string(),
    passed: z.boolean(),
    timestamp: z.coerce.date(),
    criteriaResults: z.array(CriterionResultSchema).optional(),
    harUrl: z.string().optional(),
    videoUrls: z.array(z.string()).optional(),
    tokenUsage: TokenUsageSchema.optional(),
    startedAt: z.coerce.date().optional(),
    durationMs: z.number().optional(),
    toolCalls: z.array(z.object({
      id: z.string(),
      name: z.string(),
      arguments: z.record(z.string(), z.unknown()),
      response: z.string().optional(),
      timestamp: z.string().optional(),
    })).optional(),
    toolCallsUrl: z.string().optional(),
    toolCallCount: z.number().optional(),
    aiCallCount: z.number().optional(),
    rawChatUrl: z.string().optional(),
    rawChatFormat: z.string().optional(),
    chatResultUrl: z.string().optional(),
    chatResultFormat: z.string().optional(),
  })
  .openapi("ConversationTurn");

export const RequestStatusSchema = z.enum([
  "pending",
  "queued",
  "processing",
  "paused",
  "done",
]);

export const RequestOutcomeSchema = z.enum([
  "succeeded",
  "failed",
  "finished",
]);

export const VALID_WORKERS = [
  "coder-acp-claude-code",
  "coder-acp-copilot",
  "coder-vscode-web",
] as const;

export const WorkerTypeSchema = z.enum(VALID_WORKERS);

export const CreateRequestInputSchema = z
  .object({
    scenario: ScenarioSchema,
    model: z.string().optional(),
    maxIterations: z.number().optional(),
    personaInstructions: z.string().optional(),
    persona: PersonaSchema.optional(),
    mcpServers: z.array(z.string()).optional(),
    skillRevisions: z.array(z.string()).optional(),
    extensions: z.array(z.string()).optional(),
    profileId: z.string().optional(),
    priority: z.number().int().optional(),
  })
  .openapi("CreateRequestInput");

export const RequestResponseSchema = z
  .object({
    _id: z.string(),
    scenario: ScenarioSchema,
    workerType: z.string(),
    model: z.string().optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    maxIterations: z.number().optional(),
    personaInstructions: z.string().optional(),
    persona: PersonaSchema.optional(),
    deletedAt: z.coerce.date().optional(),
    taskPromptId: z.string().optional(),
    mcpServers: z.array(z.string()).optional(),
    skillRevisions: z.array(z.string()).optional(),
    extensions: z.array(z.string()).optional(),
    agentVersion: z.string().optional(),
    profileId: z.string().optional(),
    profileVersionId: z.string().optional(),
    submissionId: z.string().optional(),
    priority: z.number().int().default(0),
    // Per-attempt state lives in the run sub-document.
    run: z
      .lazy(() => RunStateSchema)
      .optional(),
  })
  .openapi("RequestResponse");

/**
 * RunStateSchema — represents one execution attempt of a request.
 *
 * Per-attempt state is split out from RequestDocument so that retries can
 * preserve the history of previous attempts (in the `runs` collection) while
 * the request itself keeps its stable identity and immutable configuration.
 *
 * The current (latest) attempt is embedded in the request document as
 * `RequestDocument.run`. When a request is retried, the previous `run` is
 * snapshotted to the `runs` collection (as a RunHistoryDocument) and a fresh
 * RunState is created for the new attempt.
 *
 * RunState `_id` is unique per attempt — when demoted to history it becomes
 * the `runs` collection's document `_id`.
 */
export const RunStateSchema = z
  .object({
    _id: z.string(),                                     // Unique per attempt
    attemptNumber: z.number().int().min(1),              // 1, 2, 3…
    status: RequestStatusSchema,
    outcome: RequestOutcomeSchema.optional(),
    result: z.string().optional(),
    error: z.string().optional(),
    logsUrl: z.string().optional(),
    updatedAt: z.coerce.date().optional(),
    startedAt: z.coerce.date().optional(),               // When worker picked up this attempt
    finishedAt: z.coerce.date().optional(),              // When this attempt reached "done"
    turns: z.array(ConversationTurnSchema).optional(),
    workerVersion: z.string().optional(),
    os: z.object({
      platform: z.string(),
      release: z.string(),
      arch: z.string(),
    }).optional(),
    lastHeartbeatAt: z.coerce.date().optional(),
    worker: z.object({
      instanceId: z.string(),
      podName: z.string().optional(),
    }).optional(),
    harUrl: z.string().optional(),
    videoUrls: z.array(z.string()).optional(),
    setupVideoUrls: z.array(z.string()).optional(),
    tokenUsage: TokenUsageSchema.optional(),
    aiCallCount: z.number().optional(),
    rawChatUrl: z.string().optional(),
    rawChatFormat: z.string().optional(),
    pausedAt: z.coerce.date().optional(),
    resumedAt: z.coerce.date().optional(),
  })
  .openapi("RunState");

/**
 * RunHistoryDocumentSchema — a previously-completed attempt stored in the
 * `runs` collection for history. Same shape as RunState plus a back-reference
 * to the parent request.
 */
export const RunHistoryDocumentSchema = RunStateSchema.extend({
  requestId: z.string(),
}).openapi("RunHistoryDocument");

export const ListRequestsQuerySchema = z
  .object({
    worker: z.string().optional(),
    taskPromptId: z.string().optional(),
    criteria: z.string().optional(),
    submissionId: z.string().optional(),
    profileId: z.string().optional(),
    status: RequestStatusSchema.optional(),
    outcome: RequestOutcomeSchema.optional(),
    groupBy: z.enum(["task", "submissionId", "profile"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    after: z.string().optional(),
    before: z.string().optional(),
    last: z.enum(["true", "false"]).optional(),
    sortBy: z.enum(["createdAt", "priority"]).optional(),
    // Iteration-count filters. `turns` matches the actual number of turns
    // executed (size of run.turns); `maxIterations` matches the configured
    // upper bound. Each pairs with an operator (default "eq").
    turns: z.coerce.number().int().min(0).optional(),
    turnsOp: z.enum(["eq", "gte", "lte"]).optional(),
    maxIterations: z.coerce.number().int().min(0).optional(),
    maxIterationsOp: z.enum(["eq", "gte", "lte"]).optional(),
  })
  .openapi("ListRequestsQuery");

export const AggregateStatsSchema = z
  .object({
    min: z.number(),
    max: z.number(),
    mean: z.number(),
    stdDev: z.number(),
  })
  .openapi("AggregateStats");

export const GroupUniformValuesSchema = z
  .object({
    workerType: z.string().optional(),
    model: z.string().optional(),
    agentVersion: z.string().optional(),
    platform: z.string().optional(),
    mcpServers: z.array(z.string()).optional(),
    skillRevisions: z.array(z.string()).optional(),
    extensions: z.array(z.string()).optional(),
    status: RequestStatusSchema.optional(),
    submissionId: z.string().optional(),
    task: z.string().optional(),
  })
  .openapi("GroupUniformValues");

export const GroupAggregatesSchema = z
  .object({
    count: z.number(),
    turns: AggregateStatsSchema.nullable(),
    duration: AggregateStatsSchema.nullable(),
    promptTokens: AggregateStatsSchema.nullable(),
    completionTokens: AggregateStatsSchema.nullable(),
    statusCounts: z.record(z.string(), z.number()),
    outcomeCounts: z.record(z.string(), z.number()),
  })
  .openapi("GroupAggregates");

export const RunGroupSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    runIds: z.array(z.string()),
    aggregates: GroupAggregatesSchema,
    uniform: GroupUniformValuesSchema,
  })
  .openapi("RunGroup");

export const CursorsSchema = z
  .object({
    next: z.string().nullable(),
    prev: z.string().nullable(),
  })
  .openapi("Cursors");

export const PaginatedRunsResponseSchema = z
  .object({
    data: z.array(RequestResponseSchema),
    limit: z.number(),
    estimatedTotal: z.number(),
    cursors: CursorsSchema,
  })
  .openapi("PaginatedRunsResponse");

export const PaginatedRunGroupsResponseSchema = z
  .object({
    data: z.array(RunGroupSchema),
    limit: z.number(),
    estimatedTotal: z.number(),
    cursors: CursorsSchema,
  })
  .openapi("PaginatedRunGroupsResponse");

export const BulkResubmitInputSchema = z
  .object({
    ids: z.array(z.string()).min(1),
    count: z.number().int().min(1).max(10).optional().default(1),
    overrides: z
      .object({
        profileId: z.string().nullable().optional(),
        workerType: z.string().optional(),
        model: z.string().nullable().optional(),
        maxIterations: z.number().nullable().optional(),
        mcpServers: z.array(z.string()).nullable().optional(),
        skillRevisions: z.array(z.string()).nullable().optional(),
        extensions: z.array(z.string()).nullable().optional(),
      })
      .optional(),
  })
  .openapi("BulkResubmitInput");
