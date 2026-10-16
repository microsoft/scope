// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { LogEventSchema } from "./request.js";

extendZodWithOpenApi(z);

export const InsightReferenceSchema = z
  .object({
    insightId: z.string(),
    referencedAt: z.coerce.date(),
    isNew: z.boolean(),
  })
  .openapi("InsightReference");

export const ReporterSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    gitHash: z.string(),
    model: z.string(),
    agentId: z.string(),
    agentVersion: z.string(),
  })
  .openapi("Reporter");

export const ReportStatusSchema = z.enum([
  "pending",
  "generating",
  "completed",
  "failed",
]);

export const StructuredReportArtifactSchema = z
  .object({
    schemaId: z.string(),
    schemaVersion: z.string(),
    contentType: z.literal("application/json"),
    url: z.string(),
  })
  .openapi("StructuredReportArtifact");

export const ReportResponseSchema = z
  .object({
    _id: z.string(),
    requestId: z.string().optional(),
    submissionId: z.string().optional(),
    submissionRunId: z.string().optional(),
    templateId: z.string().optional(),
    reporter: ReporterSchema.optional(),
    content: z.string().optional(),
    structuredArtifact: StructuredReportArtifactSchema.optional(),
    status: ReportStatusSchema,
    error: z.string().optional(),
    insightReferences: z.array(InsightReferenceSchema).optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    projectId: z.string(),
  })
  .superRefine((report, context) => {
    if (
      !report.requestId &&
      !(report.submissionId && report.submissionRunId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Report must identify either a request or an exact submission attempt",
      });
    }
  })
  .openapi("ReportResponse");

export const CreateReportInputSchema = z
  .object({
    requestId: z.string(),
    templateId: z.string().optional(),
  })
  .openapi("CreateReportInput");

export const BulkCreateReportsInputSchema = z
  .object({
    requestIds: z.array(z.string()),
    templateId: z.string().optional(),
  })
  .openapi("BulkCreateReportsInput");

export const BulkReportStatusInputSchema = z
  .object({
    reportIds: z.array(z.string()),
  })
  .openapi("BulkReportStatusInput");

export const TriggerReportsInputSchema = z
  .object({
    requestId: z.string(),
  })
  .openapi("TriggerReportsInput");

export const TriggerSubmissionReportsInputSchema = z
  .object({
    submissionId: z.string(),
    submissionRunId: z.string(),
  })
  .openapi("TriggerSubmissionReportsInput");

export const BulkTriggerReportsInputSchema = z
  .object({
    requestIds: z.array(z.string()),
  })
  .openapi("BulkTriggerReportsInput");

export const BulkReportSummaryInputSchema = z
  .object({
    requestIds: z.array(z.string()),
  })
  .openapi("BulkReportSummaryInput");

export const ReportSummarySchema = z
  .object({
    total: z.number(),
    pending: z.number(),
    generating: z.number(),
    completed: z.number(),
    failed: z.number(),
  })
  .openapi("ReportSummary");

export const BulkReportSummaryResponseSchema = z
  .record(z.string(), ReportSummarySchema)
  .openapi("BulkReportSummaryResponse");
