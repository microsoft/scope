// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const SubmissionRequestRefSchema = z
  .object({
    requestId: z.string(),
    runId: z.string(),
  })
  .openapi("SubmissionRequestRef");

export const SubmissionDependencyStateSchema = z.enum([
  "waiting",
  "ready",
  "failed",
  "blocked",
]);

export const SubmissionDependencyProjectionSchema = z
  .object({
    requestId: z.string(),
    runId: z.string(),
    handlerId: z.string(),
    state: SubmissionDependencyStateSchema,
    version: z.number().optional(),
    updatedAt: z.coerce.date().optional(),
    error: z.string().optional(),
  })
  .openapi("SubmissionDependencyProjection");

export const SubmissionBlockingDetailSchema = z
  .object({
    requestId: z.string(),
    runId: z.string(),
    handlerId: z.string(),
    reason: z.enum([
      "request-missing",
      "run-changed",
      "dependency-not-ready",
      "dependency-failed",
      "dependency-blocked",
    ]),
    error: z.string().optional(),
  })
  .openapi("SubmissionBlockingDetail");

export const SubmissionHandlerStatusSchema = z
  .object({
    status: z.enum(["queued", "processing", "done", "failed"]),
    version: z.number().optional(),
    updatedAt: z.coerce.date().optional(),
    error: z.string().optional(),
  })
  .openapi("SubmissionHandlerStatus");

export const SubmissionReportPointerSchema = z
  .object({
    reportId: z.string().optional(),
    url: z.string().optional(),
    updatedAt: z.coerce.date().optional(),
  })
  .openapi("SubmissionReportPointer");

export const SubmissionRolloverClaimSchema = z.object({
  nextSubmissionRunId: z.string(),
  vectorFingerprint: z.string(),
  requests: z.array(SubmissionRequestRefSchema),
  reason: z.enum(["request-vector-changed", "manual-retry"]),
  claimedAt: z.coerce.date(),
});

export const SubmissionRunStateSchema = z
  .object({
    _id: z.string(),
    attemptNumber: z.number().int().min(1),
    vectorFingerprint: z.string(),
    requests: z.array(SubmissionRequestRefSchema),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    startedAt: z.coerce.date().optional(),
    finishedAt: z.coerce.date().optional(),
    dependencyProjection: z.array(SubmissionDependencyProjectionSchema).default([]),
    handlerStatus: z.record(z.string(), SubmissionHandlerStatusSchema).optional(),
    blocking: z.array(SubmissionBlockingDetailSchema).default([]),
    report: SubmissionReportPointerSchema.optional(),
    reconcileAfter: z.coerce.date().optional(),
    rollover: SubmissionRolloverClaimSchema.optional(),
    supersededAt: z.coerce.date().optional(),
    supersededBySubmissionRunId: z.string().optional(),
    supersededReason: z.enum(["request-vector-changed", "manual-retry"]).optional(),
  })
  .openapi("SubmissionRunState");

export const SubmissionDocumentSchema = z
  .object({
    _id: z.string(),
    submissionId: z.string(),
    projectId: z.string(),
    requestIds: z.array(z.string()).min(1),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    run: SubmissionRunStateSchema,
  })
  .openapi("SubmissionDocument");

export const SubmissionRunHistoryDocumentSchema = SubmissionRunStateSchema.extend({
  submissionId: z.string(),
  projectId: z.string(),
}).openapi("SubmissionRunHistoryDocument");

export const SubmissionRunResponseSchema = SubmissionRunStateSchema.omit({
  reconcileAfter: true,
  rollover: true,
})
  .extend({
    submissionId: z.string().optional(),
    projectId: z.string().optional(),
  })
  .openapi("SubmissionRunResponse");

export const SubmissionReadinessSchema = z.enum([
  "waiting",
  "ready",
  "blocked",
  "processing",
  "done",
  "failed",
]);

export const SubmissionRequestSummarySchema = z
  .object({
    requestId: z.string(),
    runId: z.string(),
    task: z.string(),
    status: z.string(),
    outcome: z.string().optional(),
    workerType: z.string(),
    model: z.string().optional(),
    profileId: z.string().optional(),
  })
  .openapi("SubmissionRequestSummary");

export const SubmissionResponseSchema = z
  .object({
    submissionId: z.string(),
    projectId: z.string(),
    requestIds: z.array(z.string()),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    submissionRunId: z.string(),
    attemptNumber: z.number().int(),
    readiness: SubmissionReadinessSchema,
    requests: z.array(SubmissionRequestSummarySchema),
    dependencyProjection: z.array(SubmissionDependencyProjectionSchema),
    blocking: z.array(SubmissionBlockingDetailSchema),
    handlerProgress: z.record(z.string(), SubmissionHandlerStatusSchema).optional(),
    report: SubmissionReportPointerSchema.optional(),
    supersededAt: z.coerce.date().optional(),
    supersededBySubmissionRunId: z.string().optional(),
    supersededReason: z.enum(["request-vector-changed", "manual-retry"]).optional(),
  })
  .openapi("SubmissionResponse");

export const SubmissionListResponseSchema = z
  .object({
    submissions: z.array(SubmissionResponseSchema),
  })
  .openapi("SubmissionListResponse");

export const SubmissionRetryResponseSchema = z
  .object({
    submissionId: z.string(),
    submissionRunId: z.string(),
    attemptNumber: z.number().int(),
    readiness: SubmissionReadinessSchema,
    blocking: z.array(SubmissionBlockingDetailSchema),
  })
  .openapi("SubmissionRetryResponse");
