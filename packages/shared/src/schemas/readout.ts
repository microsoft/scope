// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";

export const EXPERIMENT_READOUT_SCHEMA_ID = "scope.experiment-readout";
export const EXPERIMENT_READOUT_SCHEMA_VERSION = "1.0";

export const readoutObservationSchema = z.object({
  criterionId: z.string().min(1),
  taxonomyElementId: z.string().optional(),
  subject: z.enum(["run", "iteration"]),
  passed: z.boolean(),
  feedback: z.string(),
});

export const readoutEvidenceSchema = z.object({
  experimentExecutionId: z.string().min(1),
  requestId: z.string().min(1),
  runId: z.string().min(1),
  iteration: z.number().int().min(0).optional(),
  criterionId: z.string().min(1).optional(),
  excerpt: z.string().min(1),
});

export const readoutRunSchema = z.object({
  requestId: z.string().min(1),
  runId: z.string().min(1),
  task: z.string(),
  workerType: z.string().min(1),
  model: z.string().optional(),
  profileId: z.string().optional(),
  profileVersionId: z.string().optional(),
  status: z.string(),
  outcome: z.string().optional(),
  observations: z.array(readoutObservationSchema),
  trajectoryHighlights: z.array(z.string().min(1)),
});

export const readoutFindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  evidence: z.array(readoutEvidenceSchema).min(1),
});

export const readoutActionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  priority: z.enum(["critical", "high", "medium", "low"]),
  description: z.string().min(1),
  relatedFindingIds: z.array(z.string().min(1)),
});

export const experimentReadoutSchema = z.object({
  meta: z.object({
    schemaId: z.literal(EXPERIMENT_READOUT_SCHEMA_ID),
    schemaVersion: z.literal(EXPERIMENT_READOUT_SCHEMA_VERSION),
    generatedAt: z.string().datetime({ offset: true }),
    experimentId: z.string().min(1),
    experimentExecutionId: z.string().min(1),
  }),
  summary: z.object({
    title: z.string().min(1),
    executiveSummary: z.string().min(1),
    totalRuns: z.number().int().min(1),
    succeededRuns: z.number().int().min(0),
    failedRuns: z.number().int().min(0),
    passedObservations: z.number().int().min(0),
    failedObservations: z.number().int().min(0),
  }),
  profiles: z.array(z.object({
    profileId: z.string().optional(),
    requestIds: z.array(z.string().min(1)).min(1),
    summary: z.string().min(1),
  })),
  runs: z.array(readoutRunSchema).min(1),
  findings: z.array(readoutFindingSchema),
  actions: z.array(readoutActionSchema),
});

export type ExperimentReadout = z.infer<typeof experimentReadoutSchema>;
export type ReadoutRun = z.infer<typeof readoutRunSchema>;
