// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { Document } from "mongodb";
import type { Response } from "express";
import {
  CreateRequestInputSchema,
  ExperimentStore,
  fingerprintExperimentPayload,
  ReportResponseSchema,
  withRetry,
  type ExperimentDocument,
  type ExperimentExecution,
  type ExperimentExecutionHistoryDocument,
  type ExperimentMetadata,
  type ExperimentRequestState,
} from "shared";
import type { RequestDocument, RouteContext } from "../route-context.js";
import { apiRoute } from "../openapi/api-route.js";
import {
  ProjectIdQuerySchema,
  getQueryProjectId,
} from "../utils/project-scope.js";
import { subscribeClient, unsubscribeClient } from "../utils/sse.js";
import type { SSEClient } from "../utils/sse.js";

const CursorSchema = z.string().min(1).optional();
const PageQuerySchema = ProjectIdQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: CursorSchema,
});

const ExperimentMetadataInputSchema = z.object({
  name: z.string().trim().min(1).max(256),
  description: z.string().max(4_096).optional(),
}).strict();

const ExperimentRequestInputSchema = CreateRequestInputSchema.omit({
  profileVariations: true,
}).extend({
  workerType: z.string().trim().min(1),
});

const CreateExperimentInputSchema = z
  .object({
    mode: z.enum(["compose", "empty"]),
    metadata: ExperimentMetadataInputSchema,
    requests: z.array(ExperimentRequestInputSchema).max(250_000).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "empty" && value.requests.length !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["requests"],
        message: "empty mode requires an empty requests array",
      });
    }
    if (value.mode === "compose" && value.requests.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["requests"],
        message: "compose mode requires at least one request",
      });
    }
  })
  .openapi("CreateExperimentInput");

const HandlerProgressSchema = z.record(
  z.string(),
  z.object({
    status: z.enum(["queued", "processing", "done", "failed"]),
    updatedAt: z.coerce.date(),
    error: z.string().optional(),
  }),
);

const ReadinessSchema = z.enum([
  "empty",
  "waiting",
  "blocked",
  "ready",
  "processing",
  "done",
  "failed",
]);

const ExperimentReportReferenceSchema = z.object({
  reportId: z.string(),
  url: z.string(),
  updatedAt: z.coerce.date(),
});

const ExperimentResponseSchema = z
  .object({
    experimentId: z.string(),
    projectId: z.string(),
    metadata: ExperimentMetadataInputSchema.extend({
      createdBy: z.string().optional(),
    }),
    revision: z.object({
      experimentRevisionId: z.string(),
      revisionNumber: z.number().int(),
      memberCount: z.number().int(),
      createdAt: z.coerce.date(),
    }),
    currentExecution: z.object({
      experimentExecutionId: z.string(),
      attemptNumber: z.number().int(),
      readiness: ReadinessSchema,
      blockers: z.array(
        z.object({
          requestId: z.string().optional(),
          runId: z.string().optional(),
          handlerId: z.string(),
          reason: z.string(),
          error: z.string().optional(),
        }),
      ),
      progress: HandlerProgressSchema,
      createdAt: z.coerce.date(),
      updatedAt: z.coerce.date(),
      startedAt: z.coerce.date().optional(),
      finishedAt: z.coerce.date().optional(),
      discardedAt: z.coerce.date().optional(),
      discardReason: z.string().optional(),
      report: ExperimentReportReferenceSchema.optional(),
    }),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .openapi("ExperimentResponse");

const ExperimentListResponseSchema = z
  .object({
    data: z.array(ExperimentResponseSchema),
    nextCursor: z.string().optional(),
  })
  .openapi("ExperimentListResponse");

const ExecutionResponseSchema = z
  .object({
    experimentExecutionId: z.string(),
    attemptNumber: z.number().int(),
    readiness: ReadinessSchema,
    blockers: z.array(z.object({
      requestId: z.string().optional(),
      runId: z.string().optional(),
      handlerId: z.string(),
      reason: z.string(),
      error: z.string().optional(),
    })),
    progress: HandlerProgressSchema,
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    startedAt: z.coerce.date().optional(),
    finishedAt: z.coerce.date().optional(),
    discardedAt: z.coerce.date().optional(),
    discardReason: z.string().optional(),
    supersededAt: z.coerce.date().optional(),
    supersededByExperimentExecutionId: z.string().optional(),
    supersededReason: z.enum(["rollover", "retry"]).optional(),
    report: ExperimentReportReferenceSchema.optional(),
  })
  .openapi("ExperimentExecutionResponse");

const ExecutionListResponseSchema = z
  .object({
    data: z.array(ExecutionResponseSchema),
    nextCursor: z.string().optional(),
  })
  .openapi("ExperimentExecutionListResponse");

const CreateExperimentResponseSchema = z
  .object({
    experiment: ExperimentResponseSchema,
    requestIds: z.array(z.string()),
  })
  .openapi("CreateExperimentResponse");

const RetryExperimentResponseSchema = z
  .object({
    experimentId: z.string(),
    experimentExecutionId: z.string(),
    attemptNumber: z.number().int(),
    readiness: ReadinessSchema,
    blockers: z.array(z.object({
      requestId: z.string().optional(),
      runId: z.string().optional(),
      handlerId: z.string(),
      reason: z.string(),
      error: z.string().optional(),
    })),
  })
  .openapi("RetryExperimentResponse");

type Readiness = z.infer<typeof ReadinessSchema>;

function store(ctx: RouteContext): ExperimentStore {
  return new ExperimentStore({
    experiments: ctx.experimentCollection,
    executions: ctx.experimentExecutionsCollection,
    chunks: ctx.experimentChunksCollection,
  });
}

function readiness(execution: ExperimentExecution): Readiness {
  if (execution.requests.entryCount === 0) return "empty";
  if (execution.discardedAt) return "failed";
  if (execution.blocking.some((blocker) => blocker.reason === "dependency-failed")) {
    return "failed";
  }
  if (
    execution.blocking.length > 0 &&
    execution.blocking.every(
      (blocker) => blocker.reason === "dependency-not-ready",
    )
  ) {
    return "waiting";
  }
  if (execution.blocking.length > 0) return "blocked";
  const statuses = Object.values(execution.handlerSummary);
  if (statuses.some((status) => status.status === "failed")) return "failed";
  if (statuses.some((status) => status.status === "processing" || status.status === "queued")) {
    return "processing";
  }
  if (statuses.length > 0 && statuses.every((status) => status.status === "done")) {
    return "done";
  }
  return "ready";
}

function executionResponse(execution: ExperimentExecution) {
  return {
    experimentExecutionId: execution.experimentExecutionId,
    attemptNumber: execution.attemptNumber,
    readiness: readiness(execution),
    blockers: execution.blocking,
    progress: Object.fromEntries(
      Object.entries(execution.handlerSummary).map(([handlerId, status]) => [
        handlerId,
        {
          status: status.status,
          updatedAt: status.updatedAt,
          ...(status.error ? { error: status.error } : {}),
        },
      ]),
    ),
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
    ...(execution.startedAt ? { startedAt: execution.startedAt } : {}),
    ...(execution.finishedAt ? { finishedAt: execution.finishedAt } : {}),
    ...(execution.discardedAt ? { discardedAt: execution.discardedAt } : {}),
    ...(execution.discardReason ? { discardReason: execution.discardReason } : {}),
    ...(execution.supersededAt ? { supersededAt: execution.supersededAt } : {}),
    ...(execution.supersededByExperimentExecutionId
      ? {
          supersededByExperimentExecutionId:
            execution.supersededByExperimentExecutionId,
        }
      : {}),
    ...(execution.supersededReason
      ? { supersededReason: execution.supersededReason }
      : {}),
    ...(execution.report ? { report: execution.report } : {}),
  };
}

async function streamExperimentExecutionLogs(
  ctx: RouteContext,
  req: import("express").Request,
  res: Response,
  experiment: ExperimentDocument,
  execution: ExperimentExecution,
  fromStart: boolean,
): Promise<void> {
  const isCurrent =
    experiment.execution.experimentExecutionId ===
    execution.experimentExecutionId;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  if (fromStart) {
    try {
      const pastLogs = await ctx.blobStorage.getLogEvents(
        experiment.experimentId,
        execution.experimentExecutionId,
      );
      for (const log of pastLogs) {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
      }
    } catch (error) {
      console.error(
        `Failed to replay Experiment logs for ${experiment.experimentId}/${execution.experimentExecutionId}:`,
        error,
      );
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: "Cannot connect to log storage" })}\n\n`,
      );
      res.end();
      return;
    }
  }

  const executionReadiness = readiness(execution);
  if (
    !isCurrent ||
    executionReadiness === "done" ||
    executionReadiness === "failed" ||
    executionReadiness === "blocked"
  ) {
    res.write(
      `event: done\ndata: ${JSON.stringify({ status: executionReadiness })}\n\n`,
    );
    res.end();
    return;
  }

  let cleaned = false;
  let redisSubscribed = false;
  let changeStream: ReturnType<typeof ctx.experimentCollection.watch> | null =
    null;
  const heartbeat = setInterval(() => {
    if (!cleaned) res.write(`:\n\n`);
  }, 30_000);
  const client: SSEClient = {
    res,
    accepts: (event) =>
      event.data?.runId === execution.experimentExecutionId,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      if (changeStream) {
        changeStream.close().catch((error: unknown) => {
          console.error("Error closing Experiment log change stream:", error);
        });
      }
      if (redisSubscribed) {
        unsubscribeClient(experiment.experimentId, client);
      }
      res.end();
    },
  };

  if (process.env.REDIS_HOST) {
    try {
      await subscribeClient(experiment.experimentId, client);
      redisSubscribed = true;
    } catch (error) {
      console.error(
        `Redis subscription failed for Experiment ${experiment.experimentId}:`,
        error,
      );
    }
  }
  try {
    changeStream = ctx.experimentCollection.watch(
      [
        {
          $match: {
            "documentKey._id": experiment.experimentId,
            operationType: "update",
          },
        },
      ],
      { fullDocument: "updateLookup" },
    );
    changeStream.on("change", (change: {
      operationType?: string;
      fullDocument?: ExperimentDocument;
    }) => {
      const updated = change.fullDocument;
      if (change.operationType !== "update" || !updated) return;
      if (
        updated.execution.experimentExecutionId !==
        execution.experimentExecutionId
      ) {
        res.write(
          `event: done\ndata: ${JSON.stringify({ status: "superseded" })}\n\n`,
        );
        client.cleanup();
        return;
      }
      const updatedReadiness = readiness(updated.execution);
      if (
        updatedReadiness === "done" ||
        updatedReadiness === "failed" ||
        updatedReadiness === "blocked"
      ) {
        res.write(
          `event: done\ndata: ${JSON.stringify({ status: updatedReadiness })}\n\n`,
        );
        client.cleanup();
      }
    });
    changeStream.on("error", (error: unknown) => {
      console.error(
        `Experiment log change stream failed for ${experiment.experimentId}:`,
        error,
      );
    });
  } catch (error) {
    console.error(
      `Failed to create Experiment log change stream for ${experiment.experimentId}:`,
      error,
    );
  }
  req.on("close", () => client.cleanup());
}

function experimentResponse(experiment: ExperimentDocument) {
  return {
    experimentId: experiment.experimentId,
    projectId: experiment.projectId,
    metadata: {
      name: experiment.metadata.name,
      description: experiment.metadata.description,
      createdBy: experiment.metadata.createdBy,
    },
    revision: {
      experimentRevisionId: experiment.revision.experimentRevisionId,
      revisionNumber: experiment.revision.revisionNumber,
      memberCount: experiment.revision.memberCount,
      createdAt: experiment.revision.createdAt,
    },
    currentExecution: executionResponse(experiment.execution),
    createdAt: experiment.createdAt,
    updatedAt: experiment.updatedAt,
  };
}

interface ExecutionCursor {
  attemptNumber: number;
  experimentExecutionId: string;
}

function encodeExecutionCursor(cursor: ExecutionCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString(
    "base64url",
  );
}

function decodeExecutionCursor(
  cursor: string | undefined,
): ExecutionCursor | undefined {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    const result = z
      .object({
        v: z.literal(1),
        attemptNumber: z.number().int().positive(),
        experimentExecutionId: z.string().min(1),
      })
      .strict()
      .safeParse(parsed);
    if (result.success) {
      return {
        attemptNumber: result.data.attemptNumber,
        experimentExecutionId: result.data.experimentExecutionId,
      };
    }
  } catch {
    // Converted to the route's standard 400 below.
  }
  throw new Error("Invalid experiment cursor");
}

function createRequestDocument(input: {
  requestId: string;
  runId: string;
  experimentId: string;
  expectedCount: number;
  index: number;
  projectId: string;
  body: z.infer<typeof ExperimentRequestInputSchema>;
  taskPromptId: string;
  logsUrl: string;
  now: Date;
}): RequestDocument {
  const { body } = input;
  return {
    _id: input.requestId,
    projectId: input.projectId,
    scenario: body.scenario,
    workerType: body.workerType,
    createdAt: input.now,
    taskPromptId: input.taskPromptId,
    priority: body.priority ?? 0,
    ...(body.model ? { model: body.model } : {}),
    ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
    ...(body.maxIterations ? { maxIterations: body.maxIterations } : {}),
    ...(body.personaInstructions
      ? { personaInstructions: body.personaInstructions }
      : {}),
    ...(body.persona ? { persona: body.persona } : {}),
    ...(body.mcpServers ? { mcpServers: body.mcpServers } : {}),
    ...(body.skillRevisions ? { skillRevisions: body.skillRevisions } : {}),
    ...(body.codebaseRevisionId
      ? { codebaseRevisionId: body.codebaseRevisionId }
      : {}),
    ...(body.extensions ? { extensions: body.extensions } : {}),
    ...(body.profileId ? { profileId: body.profileId } : {}),
    ...(body.gates ? { gates: body.gates } : {}),
    ...(body.observations ? { observations: body.observations } : {}),
    experimentId: input.experimentId,
    experimentExpectedRequestCount: input.expectedCount,
    experimentRequestIndex: input.index,
    experimentInitialRunId: input.runId,
    run: {
      _id: input.runId,
      attemptNumber: 1,
      status: "pending",
      logsUrl: input.logsUrl,
    },
  };
}

export function registerExperimentsRoutes(ctx: RouteContext): void {
  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/experiments",
    tags: ["Experiments"],
    summary: "Create an experiment and zero or more new requests",
    description:
      "Canonical composition endpoint. Request and run IDs are minted before insertion; " +
      "the exact revision/execution is then finalized idempotently.",
    query: ProjectIdQuerySchema,
    body: CreateExperimentInputSchema,
    response: CreateExperimentResponseSchema,
    errorResponses: {
      409: { description: "Experiment identity conflict" },
    },
    handler: async (req, res) => {
      const projectId = getQueryProjectId(req);
      const experimentId = uuidv4();
      const experimentExecutionId = uuidv4();
      const experimentRevisionId = uuidv4();
      const now = new Date();
      const identities = req.body.requests.map(() => ({
        requestId: uuidv4(),
        runId: uuidv4(),
      }));
      const requestDocs = await Promise.all(
        req.body.requests.map(async (body, index) => {
          const identity = identities[index]!;
          const taskPrompt = await ctx.taskPromptStore.findOrCreate(
            projectId,
            body.scenario.task,
          );
          return createRequestDocument({
            ...identity,
            experimentId,
            expectedCount: req.body.requests.length,
            index,
            projectId,
            body,
            taskPromptId: taskPrompt._id,
            logsUrl: ctx.blobStorage.getLogsBlobUrl(
              `${identity.requestId}/runs/${identity.runId}/run.jsonl`,
            ),
            now,
          });
        }),
      );
      if (requestDocs.length > 0) {
        await ctx.requestCollection.insertMany(requestDocs);
      }
      const requestStates: ExperimentRequestState[] = requestDocs.map((doc) => ({
        requestId: doc._id,
        runId: doc.run!._id,
        dependencies: [],
        blockers: [],
      }));
      const metadata: ExperimentMetadata = req.body.metadata;
      const experimentStore = store(ctx);
      const pending = await experimentStore.createPending({
        experimentId,
        projectId,
        metadata,
        revision: {
          experimentRevisionId,
          revisionNumber: 1,
          memberCount: requestStates.length,
          membershipFingerprint: fingerprintExperimentPayload(
            requestStates.map(({ requestId, runId }) => ({ requestId, runId })),
          ),
          definitionFingerprint: fingerprintExperimentPayload({
            metadata,
            requests: req.body.requests,
          }),
          createdAt: now,
        },
        experimentExecutionId,
        requests: requestStates,
        now,
      });
      const finalized = await experimentStore.finalizeCreation({
        projectId,
        experimentId,
        expectedExperimentExecutionId: experimentExecutionId,
        expectedStateVersion: pending.stateVersion,
        now,
      });
      if (!finalized) {
        res.status(409).json({ error: "Experiment finalization contention" });
        return;
      }
      if (requestDocs.length > 0) {
        await ctx.requestCollection.updateMany(
          {
            _id: { $in: requestDocs.map((doc) => doc._id) },
            projectId,
            experimentId,
            experimentInitialRunId: {
              $in: requestDocs.map((doc) => doc.run!._id),
            },
          },
          { $set: { experimentFinalizedAt: now } },
        );
      }
      res.status(201).json({
        experiment: experimentResponse(finalized),
        requestIds: requestDocs.map((doc) => doc._id),
      });
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/experiments",
    tags: ["Experiments"],
    summary: "List experiments",
    query: PageQuerySchema,
    response: ExperimentListResponseSchema,
    handler: async (req, res) => {
      const page = await store(ctx).listPage({
        projectId: getQueryProjectId(req),
        limit: req.query.limit,
        afterExperimentId: req.query.after,
      });
      res.json({
        data: page.experiments.map(experimentResponse),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/experiments/:id",
    tags: ["Experiments"],
    summary: "Get an experiment",
    params: z.object({ id: z.string().min(1) }),
    query: ProjectIdQuerySchema,
    response: ExperimentResponseSchema,
    errorResponses: { 404: { description: "Experiment not found" } },
    handler: async (req, res) => {
      const experiment = await store(ctx).get(
        getQueryProjectId(req),
        req.params.id,
      );
      if (!experiment) {
        res.status(404).json({ error: "Experiment not found" });
        return;
      }
      res.json(experimentResponse(experiment));
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/experiments/:id/executions",
    tags: ["Experiments"],
    summary: "List current and historical experiment executions",
    params: z.object({ id: z.string().min(1) }),
    query: ProjectIdQuerySchema.extend({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      after: CursorSchema,
    }),
    response: ExecutionListResponseSchema,
    errorResponses: { 404: { description: "Experiment not found" } },
    handler: async (req, res) => {
      const projectId = getQueryProjectId(req);
      const experiment = await ctx.experimentCollection.findOne({
        _id: req.params.id,
        projectId,
        finalizedAt: { $exists: true },
      });
      if (!experiment) {
        res.status(404).json({ error: "Experiment not found" });
        return;
      }
      const after = decodeExecutionCursor(req.query.after);
      const historyFilter: Document = {
        projectId: experiment.projectId,
        experimentId: req.params.id,
      };
      if (after) {
        historyFilter.$or = [
          { attemptNumber: { $lt: after.attemptNumber } },
          {
            attemptNumber: after.attemptNumber,
            experimentExecutionId: {
              $gt: after.experimentExecutionId,
            },
          },
        ];
      }
      const raw = await ctx.experimentExecutionsCollection
        .find(historyFilter)
        .sort({ attemptNumber: -1, experimentExecutionId: 1 })
        .limit(req.query.limit + 1)
        .toArray();
      const executions: ExperimentExecution[] =
        after ? raw : [experiment.execution, ...raw];
      const data = executions.slice(0, req.query.limit).map(executionResponse);
      const hasMore = executions.length > req.query.limit;
      const last = executions[Math.min(data.length, executions.length) - 1];
      res.json({
        data,
        ...(hasMore && last
          ? {
              nextCursor: encodeExecutionCursor({
                attemptNumber: last.attemptNumber,
                experimentExecutionId: last.experimentExecutionId,
              }),
            }
          : {}),
      });
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/experiments/:id/executions/:experimentExecutionId",
    tags: ["Experiments"],
    summary: "Get one exact experiment execution",
    params: z.object({
      id: z.string().min(1),
      experimentExecutionId: z.string().min(1),
    }),
    query: ProjectIdQuerySchema,
    response: ExecutionResponseSchema,
    errorResponses: { 404: { description: "Experiment execution not found" } },
    handler: async (req, res) => {
      const projectId = getQueryProjectId(req);
      const experiment = await ctx.experimentCollection.findOne({
        _id: req.params.id,
        projectId,
        finalizedAt: { $exists: true },
      });
      if (!experiment) {
        res.status(404).json({ error: "Experiment execution not found" });
        return;
      }
      const execution = await store(ctx).getExecution({
        projectId: experiment.projectId,
        experimentId: req.params.id,
        experimentExecutionId: req.params.experimentExecutionId,
      });
      if (!execution) {
        res.status(404).json({ error: "Experiment execution not found" });
        return;
      }
      res.json(executionResponse(execution));
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/experiments/:id/executions/:experimentExecutionId/reports",
    tags: ["Reports"],
    summary: "List reports for one exact Experiment execution",
    params: z.object({
      id: z.string().min(1),
      experimentExecutionId: z.string().min(1),
    }),
    query: ProjectIdQuerySchema,
    response: z.array(ReportResponseSchema),
    errorResponses: { 404: { description: "Experiment execution not found" } },
    handler: async (req, res) => {
      const projectId = getQueryProjectId(req);
      const execution = await store(ctx).getExecution({
        projectId,
        experimentId: req.params.id,
        experimentExecutionId: req.params.experimentExecutionId,
      });
      if (!execution) {
        res.status(404).json({ error: "Experiment execution not found" });
        return;
      }
      const reports = await ctx.reportCollection
        .find({
          projectId,
          experimentId: req.params.id,
          experimentExecutionId: req.params.experimentExecutionId,
        })
        .sort({ createdAt: -1 })
        .toArray();
      res.json(reports.map((report) => ({ ...report, id: report._id })));
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/experiments/:id/executions/:experimentExecutionId/reports/:reportId/structured",
    tags: ["Reports"],
    summary: "Download structured JSON for an exact Experiment report",
    params: z.object({
      id: z.string().min(1),
      experimentExecutionId: z.string().min(1),
      reportId: z.string().min(1),
    }),
    query: ProjectIdQuerySchema,
    response: z.any(),
    rawResponse: true,
    errorResponses: {
      404: { description: "Experiment report or structured artifact not found" },
    },
    handler: async (req, res) => {
      const projectId = getQueryProjectId(req);
      const report = await ctx.reportCollection.findOne({
        _id: req.params.reportId,
        projectId,
        experimentId: req.params.id,
        experimentExecutionId: req.params.experimentExecutionId,
      });
      if (!report?.structuredArtifact) {
        res.status(404).json({
          error: "Experiment report structured artifact not found",
        });
        return;
      }
      const structured = await withRetry(() =>
        ctx.blobStorage.downloadJson(report.structuredArtifact!.url)
      );
      res.setHeader("Content-Type", "application/json");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${req.params.reportId}.structured.json"`,
      );
      res.json(structured);
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/experiments/:id/executions/:experimentExecutionId/logs",
    tags: ["Experiments"],
    summary: "Stream logs for one exact Experiment execution",
    params: z.object({
      id: z.string().min(1),
      experimentExecutionId: z.string().min(1),
    }),
    query: ProjectIdQuerySchema.extend({
      fromStart: z.enum(["true", "false"]).optional(),
    }),
    response: z.any(),
    rawResponse: true,
    responseDescription: "Server-sent event stream of log entries",
    errorResponses: { 404: { description: "Experiment execution not found" } },
    handler: async (req, res) => {
      const projectId = getQueryProjectId(req);
      const experiment = await store(ctx).get(projectId, req.params.id);
      const execution = experiment
        ? await store(ctx).getExecution({
            projectId,
            experimentId: req.params.id,
            experimentExecutionId: req.params.experimentExecutionId,
          })
        : null;
      if (!experiment || !execution) {
        res.status(404).json({ error: "Experiment execution not found" });
        return;
      }
      await streamExperimentExecutionLogs(
        ctx,
        req,
        res,
        experiment,
        execution,
        req.query.fromStart === "true",
      );
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/experiments/:id/retry",
    tags: ["Experiments"],
    summary: "Retry current experiment processing",
    params: z.object({ id: z.string().min(1) }),
    query: ProjectIdQuerySchema,
    body: z.object({ experimentExecutionId: z.string().min(1) }),
    response: RetryExperimentResponseSchema,
    errorResponses: {
      404: { description: "Experiment not found" },
      409: { description: "Execution is stale or cannot be retried" },
    },
    handler: async (req, res) => {
      const projectId = getQueryProjectId(req);
      const experimentStore = store(ctx);
      const current = await experimentStore.get(projectId, req.params.id);
      if (!current) {
        res.status(404).json({ error: "Experiment not found" });
        return;
      }
      if (
        current.execution.experimentExecutionId !==
        req.body.experimentExecutionId
      ) {
        res.status(409).json({
          error: "Experiment execution is stale",
          experimentExecutionId:
            current.execution.experimentExecutionId,
          blockers: current.execution.blocking,
        });
        return;
      }
      const frozen = await experimentStore.freezeCurrent({
        projectId,
        experimentId: req.params.id,
        experimentExecutionId: req.body.experimentExecutionId,
        expectedExecutionVersion: current.execution.version,
      });
      if (!frozen) {
        res.status(409).json({
          error: "Experiment retry contention",
          experimentExecutionId:
            current.execution.experimentExecutionId,
          blockers: current.execution.blocking,
        });
        return;
      }
      const retried = await experimentStore.retryCurrent({
        projectId,
        experimentId: req.params.id,
        expectedExperimentExecutionId:
          req.body.experimentExecutionId,
        expectedExecutionVersion: frozen.execution.version,
        nextExperimentExecutionId: uuidv4(),
      });
      if (!retried) {
        res.status(409).json({
          error: "Experiment retry could not be published",
          experimentExecutionId:
            current.execution.experimentExecutionId,
          blockers: current.execution.blocking,
        });
        return;
      }
      res.status(201).json({
        experimentId: retried.experimentId,
        experimentExecutionId:
          retried.execution.experimentExecutionId,
        attemptNumber: retried.execution.attemptNumber,
        readiness: readiness(retried.execution),
        blockers: retried.execution.blocking,
      });
    },
  });
}
