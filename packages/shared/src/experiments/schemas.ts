// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  EXPERIMENT_REQUEST_BUCKET_ASSIGNMENT_VERSION,
  EXPERIMENT_STORAGE_PROFILE_VERSION,
} from "./types.js";

const IdSchema = z.string().trim().min(1).max(200);
const ErrorSchema = z.string().max(2_048);

export const ExperimentDependencyProjectionSchema = z
  .object({
    handlerId: IdSchema,
    state: z.enum(["waiting", "ready", "failed", "blocked"]),
    version: z.number().int().nonnegative().optional(),
    updatedAt: z.coerce.date().optional(),
    error: ErrorSchema.optional(),
  })
  .strict();

export const ExperimentBlockerSchema = z
  .object({
    requestId: IdSchema.optional(),
    runId: IdSchema.optional(),
    handlerId: IdSchema,
    reason: z.enum([
      "request-missing",
      "run-changed",
      "dependency-not-ready",
      "dependency-failed",
      "dependency-blocked",
    ]),
    error: ErrorSchema.optional(),
  })
  .strict();

export const ExperimentRequestStateSchema = z
  .object({
    requestId: IdSchema,
    runId: IdSchema,
    dependencies: z.array(ExperimentDependencyProjectionSchema).max(32),
    blockers: z.array(ExperimentBlockerSchema).max(32),
  })
  .strict();

export const ExperimentMetadataSchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    description: z.string().max(4_096).optional(),
    createdBy: IdSchema.optional(),
  })
  .strict();

export const ExperimentRevisionSchema = z
  .object({
    experimentRevisionId: IdSchema,
    revisionNumber: z.number().int().min(1),
    memberCount: z.number().int().nonnegative(),
    membershipFingerprint: IdSchema,
    reportTemplateIds: z.array(IdSchema).max(64).default([]),
    definitionFingerprint: IdSchema,
    createdAt: z.coerce.date(),
  })
  .strict();

export const ExperimentHandlerSummarySchema = z
  .object({
    status: z.enum(["queued", "processing", "done", "failed"]),
    version: z.number().int().nonnegative(),
    claimToken: IdSchema.optional(),
    updatedAt: z.coerce.date(),
    error: ErrorSchema.optional(),
  })
  .strict();

export const ExperimentFixedRequestPayloadSchema = z.discriminatedUnion(
  "storage",
  [
    z
      .object({
        storage: z.literal("inline"),
        entryCount: z.number().int().nonnegative(),
        payloadFingerprint: IdSchema,
        payloadVersion: z.number().int().positive(),
        entries: z.array(ExperimentRequestStateSchema),
      })
      .strict()
      .refine((value) => value.entryCount === value.entries.length, {
        message: "Inline entryCount must equal entries.length",
      }),
    z
      .object({
        storage: z.literal("chunked"),
        entryCount: z.number().int().positive(),
        payloadFingerprint: IdSchema,
        payloadVersion: z.number().int().positive(),
        assignmentVersion: z.literal(
          EXPERIMENT_REQUEST_BUCKET_ASSIGNMENT_VERSION,
        ),
        bucketCount: z.number().int().positive(),
        chunkIds: z.array(IdSchema).min(1),
      })
      .strict()
      .refine((value) => value.bucketCount === value.chunkIds.length, {
        message: "Chunked bucketCount must equal chunkIds.length",
      }),
  ],
);

const ExperimentExecutionBaseSchema = z
  .object({
    experimentExecutionId: IdSchema,
    attemptNumber: z.number().int().min(1),
    version: z.number().int().min(1),
    requests: ExperimentFixedRequestPayloadSchema,
    vectorFingerprint: IdSchema,
    handlerSummary: z
      .record(IdSchema, ExperimentHandlerSummarySchema)
      .refine((value) => Object.keys(value).length <= 64, {
        message: "handlerSummary is limited to 64 handlers",
      }),
    reportTemplates: z
      .record(
        IdSchema,
        z
          .object({
            templateId: IdSchema,
            templateVersionId: IdSchema.optional(),
            templateVersion: z.number().int().positive().optional(),
            templateContentFingerprint: IdSchema.optional(),
            source: z.enum(["always", "linked", "selected"]),
            status: z.enum([
              "waiting",
              "not-applicable",
              "unavailable",
              "queued",
              "processing",
              "done",
              "failed",
            ]),
            claimToken: IdSchema.optional(),
            matchingRunCount: z.number().int().nonnegative(),
            blockers: z
              .array(
                z
                  .object({
                    requestId: IdSchema.optional(),
                    runId: IdSchema.optional(),
                    runTemplateId: IdSchema.optional(),
                    reason: z.enum([
                      "run-template-unused",
                      "run-report-pending",
                      "run-report-failed",
                      "template-unavailable",
                    ]),
                    error: ErrorSchema.optional(),
                  })
                  .strict(),
              )
              .max(256),
            report: z
              .object({
                reportId: IdSchema,
                url: z.string().min(1).max(2_048),
                updatedAt: z.coerce.date(),
              })
              .strict()
              .optional(),
            updatedAt: z.coerce.date(),
            error: ErrorSchema.optional(),
          })
          .strict(),
      )
      .refine((value) => Object.keys(value).length <= 64, {
        message: "reportTemplates is limited to 64 templates",
      })
      .default({}),
    blocking: z.array(ExperimentBlockerSchema).max(32),
    report: z
      .object({
        reportId: IdSchema,
        url: z.string().min(1).max(2_048),
        updatedAt: z.coerce.date(),
      })
      .strict()
      .optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    startedAt: z.coerce.date().optional(),
    finishedAt: z.coerce.date().optional(),
    frozenAt: z.coerce.date().optional(),
    discardedAt: z.coerce.date().optional(),
    discardReason: z.string().max(2_048).optional(),
    supersededAt: z.coerce.date().optional(),
    supersededByExperimentExecutionId: IdSchema.optional(),
    supersededReason: z
      .enum(["rollover", "retry", "membership", "templates"])
      .optional(),
    requestStateUpdate: z
      .object({
        updateId: IdSchema,
        expectedPayloadFingerprint: IdSchema,
        nextPayloadFingerprint: IdSchema,
        claimedAt: z.coerce.date(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ExperimentExecutionSchema: z.ZodType = ExperimentExecutionBaseSchema
  .extend({
    rollover: z
      .object({
        nextExecution: ExperimentExecutionBaseSchema,
        nextRevision: ExperimentRevisionSchema.optional(),
        reason: z.enum(["rollover", "retry", "membership", "templates"]),
        claimedAt: z.coerce.date(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ExperimentDocumentSchema = z
  .object({
    _id: IdSchema,
    experimentId: IdSchema,
    projectId: IdSchema,
    metadata: ExperimentMetadataSchema,
    storageProfileVersion: z.literal(EXPERIMENT_STORAGE_PROFILE_VERSION),
    stateVersion: z.number().int().min(1),
    revision: ExperimentRevisionSchema,
    execution: ExperimentExecutionSchema,
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    finalizedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
    lifecycle: z
      .object({
        operationId: IdSchema,
        phase: z.enum(["deleting", "deleted", "restoring", "restored"]),
        stateVersion: z.number().int().positive(),
        targets: ExperimentFixedRequestPayloadSchema,
        targetFingerprint: IdSchema,
        progress: z
          .object({
            expectedRequests: z.number().int().nonnegative(),
            completedRequests: z.number().int().nonnegative(),
            expectedReports: z.number().int().nonnegative(),
            completedReports: z.number().int().nonnegative(),
          })
          .strict(),
        blocking: z
          .array(
            z
              .object({
                kind: z.enum(["request", "report", "experiment"]),
                id: IdSchema,
                reason: z.enum([
                  "target-missing",
                  "target-conflict",
                  "reconciliation-failed",
                ]),
                error: ErrorSchema.optional(),
              })
              .strict(),
          )
          .max(32),
        deleteRequestedAt: z.coerce.date(),
        deleteCompletedAt: z.coerce.date().optional(),
        restoreRequestedAt: z.coerce.date().optional(),
        restoreCompletedAt: z.coerce.date().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ExperimentExecutionHistoryDocumentSchema =
  ExperimentExecutionBaseSchema.extend({
    _id: IdSchema,
    experimentId: IdSchema,
    projectId: IdSchema,
    storageProfileVersion: z.literal(EXPERIMENT_STORAGE_PROFILE_VERSION),
    revision: ExperimentRevisionSchema,
    archivedAt: z.coerce.date(),
  }).strict();
