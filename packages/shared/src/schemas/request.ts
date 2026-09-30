// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { ScenarioSchema, PersonaSchema } from "./scenario.js";
import { ResourceBindingSchema, ResourceBindingSpecSchema } from "./resource.js";
import { GateIdSchema } from "./criteria.js";

extendZodWithOpenApi(z);

/** Outcome of one resource's lifecycle within a run. */
export const ResourceRunOutcomeSchema = z
  .object({
    ref: z.string(),
    slug: z.string(),
    revisionId: z.string(),
    setupSucceeded: z.boolean(),
    published: z.array(z.string()),
    params: z.record(z.string(), z.string()).optional(),
    setupDurationMs: z.number().optional(),
    error: z.string().optional(),
    teardownRan: z.boolean().optional(),
  })
  .openapi("ResourceRunOutcome");

export const GateConfigSchema = z
  .object({
    gate: GateIdSchema,
    // Resolved prompt entity id. Optional on input: callers may instead supply
    // `promptText` (free text), which the submit handler materializes into a
    // typed prompt and resolves to this id. Persisted gate configs always carry
    // the resolved `promptId`.
    promptId: z.string().optional(),
    // Input-only convenience: free-text gate prompt. When present at submit it is
    // content-addressed via `findOrCreate(text, gate)` and supersedes any
    // `promptId`. Never persisted (stripped once resolved).
    promptText: z.string().optional(),
    criteria: z.array(z.string()),
    maxIterations: z.number().int().min(1).max(50).optional(),
  })
  .openapi("GateConfig");

export const GateRunSummarySchema = z
  .object({
    gate: GateIdSchema,
    status: z.enum(["passed", "failed", "skipped"]),
    iterations: z.number().int().min(0),
  })
  .openapi("GateRunSummary");

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
    gate: GateIdSchema.optional(),
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

export const CreateRequestInputSchema = z
  .object({
    scenario: ScenarioSchema,
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    maxIterations: z.number().int().min(1).max(50).optional(),
    personaInstructions: z.string().optional(),
    persona: PersonaSchema.optional(),
    mcpServers: z.array(z.string()).optional(),
    skillRevisions: z.array(z.string()).optional(),
    codebaseRevisionId: z.string().optional(),
    /** Resources to provision for this run, in setup order. Each entry is a
     *  bare spec (slug, `slug@rN`, or revision id) or an object carrying
     *  parameter values. Resolved at submit time and shared by every variation
     *  in a grouped submission, so each profile gets an identical environment. */
    resources: z.array(ResourceBindingSpecSchema).optional(),
    extensions: z.array(z.string()).optional(),
    profileId: z.string().optional(),
    profileVariations: z.array(z.string()).optional(),
    priority: z.number().int().optional(),
    // Raw AGENTS.md body to deliver to the worker workspace. When present, the
    // API findOrCreates an `agents.md`-typed prompt and stores its id on the
    // request (see `agentsMdPromptId`).
    agentsMd: z.string().optional(),
    // Lineage edges (parent AGENTS.md prompt ids) when this candidate was
    // derived from earlier ones: [] / omitted = root, [p] = mutation,
    // [i, j] = merge of two parents.
    agentsMdParentIds: z.array(z.string()).optional(),
    gates: z.array(GateConfigSchema).optional(),
  })
  .openapi("CreateRequestInput");

export const RequestResponseSchema = z
  .object({
    _id: z.string(),
    scenario: ScenarioSchema,
    workerType: z.string(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    maxIterations: z.number().optional(),
    personaInstructions: z.string().optional(),
    persona: PersonaSchema.optional(),
    deletedAt: z.coerce.date().optional(),
    taskPromptId: z.string().optional(),
    agentsMdPromptId: z.string().optional(),
    agentsMdParentIds: z.array(z.string()).optional(),
    mcpServers: z.array(z.string()).optional(),
    skillRevisions: z.array(z.string()).optional(),
    codebaseRevisionId: z.string().optional(),
    resources: z.array(ResourceBindingSchema).optional(),
    extensions: z.array(z.string()).optional(),
    agentVersion: z.string().optional(),
    profileId: z.string().optional(),
    profileVersionId: z.string().optional(),
    submissionId: z.string().optional(),
    priority: z.number().int().default(0),
    gates: z.array(GateConfigSchema).optional(),
    gateSummaries: z.array(GateRunSummarySchema).optional(),
    // Per-attempt state lives in the run sub-document.
    run: z
      .lazy(() => RunStateSchema)
      .optional(),
    projectId: z.string(),
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
    queuedQueueName: z.string().optional(),
    outcome: RequestOutcomeSchema.optional(),
    result: z.string().optional(),
    error: z.string().optional(),
    logsUrl: z.string().optional(),
    updatedAt: z.coerce.date().optional(),
    startedAt: z.coerce.date().optional(),               // When worker picked up this attempt
    finishedAt: z.coerce.date().optional(),              // When this attempt reached "done"
    durationMs: z.number().optional(),                   // Denormalized finishedAt − startedAt (ms); enables server-side sort by duration

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
    /** Per-resource lifecycle outcomes, so a run that ended up without the
     *  environment it asked for is distinguishable after the fact. */
    resources: z.array(ResourceRunOutcomeSchema).optional(),
    /** Whether MCP servers were actually registered with the gateway. False
     *  alongside a non-empty `mcpServers` means the run had no tools. */
    mcpRegistered: z.boolean().optional(),
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
  projectId: z.string(),
}).openapi("RunHistoryDocument");

/**
 * A categorical filter param that accepts a single value or repeated/comma-
 * separated values (e.g. `?status=done&status=processing` or `?status=done,processing`).
 * The literal sentinel `__empty__` selects rows missing that field. Values are
 * validated/narrowed in the list handler (apps/api/src/routes/requests/index.ts).
 */
const MultiValueParam = z.union([z.string(), z.array(z.string())]).optional();

/** Sentinel selecting rows missing a categorical field (the "(Unknown)" bucket). */
export const EMPTY_FILTER_VALUE = "__empty__";

export const ListRequestsQuerySchema = z
  .object({
    worker: MultiValueParam,
    taskPromptId: z.string().optional(),
    criteria: z.string().optional(),
    submissionId: z.string().optional(),
    profileId: MultiValueParam,
    status: MultiValueParam,
    outcome: MultiValueParam,
    model: MultiValueParam,
    os: MultiValueParam,
    priority: MultiValueParam,
    agentVersion: MultiValueParam,
    // Free-text, case-insensitive search across run id, scenario task, model, worker.
    search: z.string().optional(),
    groupBy: z.enum(["task", "submissionId", "profile"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    after: z.string().optional(),
    before: z.string().optional(),
    last: z.enum(["true", "false"]).optional(),
    // Sort allowlist → indexable stored fields. `createdAt` is a legacy alias
    // for `created`. The unset default is `created` desc (existing cursors keep working).
    sortBy: z.enum(["created", "updated", "priority", "worker", "status", "id", "duration", "createdAt"]).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    // Created-at date/time range (ISO-8601). Adopted from PR #908.
    createdAfter: z.coerce.date().optional(),
    createdBefore: z.coerce.date().optional(),
    // Iteration-count filters. `turns` matches the actual number of turns
    // executed (size of run.turns); `maxIterations` matches the configured
    // upper bound. Each pairs with an operator (default "eq").
    turns: z.coerce.number().int().min(0).optional(),
    turnsOp: z.enum(["eq", "gte", "lte"]).optional(),
    maxIterations: z.coerce.number().int().min(0).optional(),
    maxIterationsOp: z.enum(["eq", "gte", "lte"]).optional(),
  })
  .openapi("ListRequestsQuery");

/** One value bucket in a categorical facet (value + full-dataset count). */
export const RunFacetBucketSchema = z
  .object({
    value: z.string(),
    count: z.number(),
  })
  .openapi("RunFacetBucket");

/**
 * Server-computed facets for the Runs list filter rail. Each categorical
 * dimension lists every selectable value with an accurate full-dataset count
 * (honoring the active base filter but independent of categorical selections,
 * so all values stay visible). The `__empty__` bucket counts rows missing the
 * field.
 */
export const RunFacetsResponseSchema = z
  .object({
    total: z.number(),
    facets: z.object({
      workerType: z.array(RunFacetBucketSchema),
      status: z.array(RunFacetBucketSchema),
      outcome: z.array(RunFacetBucketSchema),
      model: z.array(RunFacetBucketSchema),
      os: z.array(RunFacetBucketSchema),
      priority: z.array(RunFacetBucketSchema),
      agentVersion: z.array(RunFacetBucketSchema),
      profileId: z.array(RunFacetBucketSchema),
    }),
  })
  .openapi("RunFacetsResponse");

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
    agentVersion: z.string().optional(),
    model: z.string().optional(),
    platform: z.string().optional(),
    mcpServers: z.array(z.string()).optional(),
    skillRevisions: z.array(z.string()).optional(),
    codebaseRevisionId: z.string().optional(),
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
        agentVersion: z.string().optional(),
        model: z.string().nullable().optional(),
        reasoningEffort: z.string().nullable().optional(),
        maxIterations: z.number().nullable().optional(),
        mcpServers: z.array(z.string()).nullable().optional(),
        skillRevisions: z.array(z.string()).nullable().optional(),
        extensions: z.array(z.string()).nullable().optional(),
      })
      .optional(),
  })
  .openapi("BulkResubmitInput");
