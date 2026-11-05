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
    blocking: z.array(ExperimentBlockerSchema).max(32),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    startedAt: z.coerce.date().optional(),
    finishedAt: z.coerce.date().optional(),
    frozenAt: z.coerce.date().optional(),
    discardedAt: z.coerce.date().optional(),
    discardReason: z.string().max(2_048).optional(),
    supersededAt: z.coerce.date().optional(),
    supersededByExperimentExecutionId: IdSchema.optional(),
    supersededReason: z.enum(["rollover", "retry"]).optional(),
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
        reason: z.enum(["rollover", "retry"]),
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
