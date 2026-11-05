// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  SubmissionCoordinator,
  SubmissionListResponseSchema,
  SubmissionResponseSchema,
  SubmissionRetryResponseSchema,
  SubmissionRunResponseSchema,
  type ServiceHandlerDocument,
  deriveSubmissionReadiness,
} from "shared";
import type { SubmissionDocument } from "../route-context.js";
import type { RouteContext } from "../route-context.js";
import { apiRoute } from "../openapi/api-route.js";
import { ProjectIdQuerySchema, getQueryProjectId } from "../utils/project-scope.js";

function coordinator(ctx: RouteContext): SubmissionCoordinator {
  return new SubmissionCoordinator({
    requests: ctx.requestCollection,
    submissions: ctx.submissionCollection,
    submissionRuns: ctx.submissionRunsCollection,
    services: ctx.db.collection<ServiceHandlerDocument>("services"),
  });
}

function toRunResponse<T extends { reconcileAfter?: Date; rollover?: unknown }>(
  run: T,
): Omit<T, "reconcileAfter" | "rollover"> {
  const {
    reconcileAfter: _reconcileAfter,
    rollover: _rollover,
    ...response
  } = run;
  return response;
}

function retryBlocking(submission: SubmissionDocument) {
  if (submission.run.blocking.length > 0) return submission.run.blocking;
  return submission.run.dependencyProjection
    .filter((dependency) => dependency.state !== "ready")
    .map((dependency) => ({
      requestId: dependency.requestId,
      runId: dependency.runId,
      handlerId: dependency.handlerId,
      reason: "dependency-not-ready" as const,
      ...(dependency.error ? { error: dependency.error } : {}),
    }));
}

async function toResponse(ctx: RouteContext, submission: SubmissionDocument) {
  const requestDocs = await ctx.requestCollection
    .find({
      _id: { $in: submission.requestIds },
      projectId: submission.projectId,
      deletedAt: { $exists: false },
    })
    .toArray();
  const byId = new Map(requestDocs.map((request) => [request._id, request]));
  const requests = submission.run.requests.flatMap((ref) => {
    const request = byId.get(ref.requestId);
    if (!request) return [];
    return [{
      requestId: request._id,
      runId: ref.runId,
      task: request.scenario.task,
      status: request.run?.status ?? "unknown",
      ...(request.run?.outcome ? { outcome: request.run.outcome } : {}),
      workerType: request.workerType,
      ...(request.model ? { model: request.model } : {}),
      ...(request.profileId ? { profileId: request.profileId } : {}),
    }];
  });
  return {
    submissionId: submission._id,
    projectId: submission.projectId,
    requestIds: submission.requestIds,
    createdAt: submission.createdAt,
    ...(submission.updatedAt ? { updatedAt: submission.updatedAt } : {}),
    submissionRunId: submission.run._id,
    attemptNumber: submission.run.attemptNumber,
    readiness: deriveSubmissionReadiness(submission.run),
    requests,
    dependencyProjection: submission.run.dependencyProjection,
    blocking: submission.run.blocking,
    ...(submission.run.handlerStatus
      ? { handlerProgress: submission.run.handlerStatus }
      : {}),
    ...(submission.run.report ? { report: submission.run.report } : {}),
    ...(submission.run.supersededAt
      ? { supersededAt: submission.run.supersededAt }
      : {}),
    ...(submission.run.supersededBySubmissionRunId
      ? { supersededBySubmissionRunId: submission.run.supersededBySubmissionRunId }
      : {}),
    ...(submission.run.supersededReason
      ? { supersededReason: submission.run.supersededReason }
      : {}),
  };
}

export function registerSubmissionsRoutes(ctx: RouteContext): void {
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/submissions",
    tags: ["Submissions"],
    summary: "List submissions",
    query: ProjectIdQuerySchema.extend({
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
    response: SubmissionListResponseSchema,
    handler: async (req, res) => {
      const projectId = getQueryProjectId(req);
      const docs = await ctx.submissionCollection
        .find({ projectId })
        .sort({ createdAt: -1, _id: -1 })
        .limit(req.query.limit)
        .toArray();
      res.json({
        submissions: await Promise.all(docs.map((doc) => toResponse(ctx, doc))),
      });
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/submissions/:id",
    tags: ["Submissions"],
    summary: "Get a submission",
    params: z.object({ id: z.string() }),
    response: SubmissionResponseSchema,
    errorResponses: { 404: { description: "Submission not found" } },
    handler: async (req, res) => {
      const reconciled = await coordinator(ctx).reconcile(req.params.id);
      if (!reconciled) {
        res.status(404).json({ error: "Submission not found" });
        return;
      }
      res.json(await toResponse(ctx, reconciled.submission));
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/submissions/:id/runs",
    tags: ["Submissions"],
    summary: "List current and historical submission attempts",
    params: z.object({ id: z.string() }),
    response: z.object({ runs: z.array(SubmissionRunResponseSchema) }),
    errorResponses: { 404: { description: "Submission not found" } },
    handler: async (req, res) => {
      const submission = await ctx.submissionCollection.findOne({ _id: req.params.id });
      if (!submission) {
        res.status(404).json({ error: "Submission not found" });
        return;
      }
      const historical = await ctx.submissionRunsCollection
        .find({ submissionId: req.params.id })
        .sort({ attemptNumber: -1 })
        .toArray();
      res.json({
        runs: [toRunResponse(submission.run), ...historical.map(toRunResponse)],
      });
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/submissions/:id/runs/:submissionRunId",
    tags: ["Submissions"],
    summary: "Get one submission attempt",
    params: z.object({ id: z.string(), submissionRunId: z.string() }),
    response: SubmissionRunResponseSchema,
    errorResponses: { 404: { description: "Submission attempt not found" } },
    handler: async (req, res) => {
      const submission = await ctx.submissionCollection.findOne({ _id: req.params.id });
      if (submission?.run._id === req.params.submissionRunId) {
        res.json(toRunResponse(submission.run));
        return;
      }
      const historical = await ctx.submissionRunsCollection.findOne({
        _id: req.params.submissionRunId,
        submissionId: req.params.id,
      });
      if (!historical) {
        res.status(404).json({ error: "Submission attempt not found" });
        return;
      }
      res.json(toRunResponse(historical));
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/submissions/:id/retry",
    tags: ["Submissions"],
    summary: "Retry current submission processing",
    params: z.object({ id: z.string() }),
    body: z.object({ submissionRunId: z.string() }),
    response: SubmissionRetryResponseSchema,
    errorResponses: {
      404: { description: "Submission not found" },
      409: { description: "Submission attempt is stale or dependencies are blocked" },
    },
    handler: async (req, res) => {
      const current = await ctx.submissionCollection.findOne({ _id: req.params.id });
      if (!current) {
        res.status(404).json({ error: "Submission not found" });
        return;
      }
      if (current.run._id !== req.body.submissionRunId) {
        res.status(409).json({
          error: "Submission attempt is stale",
          submissionRunId: current.run._id,
          blocking: retryBlocking(current),
        });
        return;
      }
      const result = await coordinator(ctx).retryCurrent(
        req.params.id,
        req.body.submissionRunId,
      );
      if (!result) {
        res.status(404).json({ error: "Submission not found" });
        return;
      }
      if (result.readiness === "blocked" || result.readiness === "waiting") {
        res.status(409).json({
          error: "Submission dependencies are not ready",
          submissionRunId: result.submission.run._id,
          blocking: retryBlocking(result.submission),
        });
        return;
      }
      res.status(201).json({
        submissionId: result.submission._id,
        submissionRunId: result.submission.run._id,
        attemptNumber: result.submission.run.attemptNumber,
        readiness: result.readiness,
        blocking: result.submission.run.blocking,
      });
    },
  });
}
