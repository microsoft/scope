// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

const AlwaysTriggerSchema = z.object({
  type: z.literal("always"),
});

const CriteriaTriggerSchema = z.object({
  type: z.literal("criteria"),
  criteriaIds: z.array(z.string()),
  match: z.enum(["any", "all"]).optional(),
});

const TaskPromptTriggerSchema = z.object({
  type: z.literal("taskPrompt"),
  taskPromptIds: z.array(z.string()),
});

const PromptFeatureTriggerSchema = z.object({
  type: z.literal("promptFeature"),
  featureIds: z.array(z.string()),
  match: z.enum(["any", "all"]).optional(),
});

const RunReportTemplatesTriggerSchema = z.object({
  type: z.literal("run-report-templates"),
  reportTemplateIds: z.array(z.string().min(1)).min(1),
});

export const ReportTriggerSchema = z
  .discriminatedUnion("type", [
    AlwaysTriggerSchema,
    CriteriaTriggerSchema,
    TaskPromptTriggerSchema,
    PromptFeatureTriggerSchema,
    RunReportTemplatesTriggerSchema,
  ])
  .openapi("ReportTrigger");

export const ReportTemplateSubjectSchema = z
  .enum(["run", "experiment"])
  .openapi("ReportTemplateSubject");

export const ReportTemplateSystemPromptSchema = z
  .object({
    mode: z.enum(["append", "override"]),
    content: z.string(),
  })
  .openapi("ReportTemplateSystemPrompt");

export const CreateReportTemplateInputSchema = z
  .object({
    id: z.string(),
    subject: ReportTemplateSubjectSchema.default("run"),
    name: z.string(),
    description: z.string().optional(),
    userPrompt: z.string(),
    systemPrompt: ReportTemplateSystemPromptSchema.optional(),
    trigger: ReportTriggerSchema.optional(),
    model: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (
      value.subject === "run" &&
      value.trigger?.type === "run-report-templates"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["trigger"],
        message:
          "run-report-templates is only valid for experiment report templates",
      });
    }
    if (
      value.subject === "experiment" &&
      value.trigger &&
      value.trigger.type !== "always" &&
      value.trigger.type !== "run-report-templates"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["trigger"],
        message:
          "experiment report templates support only always, run-report-templates, or no trigger",
      });
    }
  })
  .openapi("CreateReportTemplateInput");

export const UpdateReportTemplateInputSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    userPrompt: z.string().optional(),
    systemPrompt: ReportTemplateSystemPromptSchema.nullable().optional(),
    trigger: ReportTriggerSchema.optional(),
    model: z.string().nullable().optional(),
    timeoutMs: z.number().int().positive().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("UpdateReportTemplateInput");

export const ReportTemplateResponseSchema = z
  .object({
    _id: z.string(),
    id: z.string(),
    subject: ReportTemplateSubjectSchema,
    name: z.string(),
    description: z.string().optional(),
    userPrompt: z.string(),
    systemPrompt: ReportTemplateSystemPromptSchema.optional(),
    trigger: ReportTriggerSchema.optional(),
    model: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    enabled: z.boolean(),
    currentVersionId: z.string(),
    currentVersion: z.number().int().positive(),
    contentFingerprint: z.string(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
    projectId: z.string(),
  })
  .openapi("ReportTemplateResponse");

export const ReportTemplateVersionResponseSchema = z
  .object({
    _id: z.string(),
    projectId: z.string(),
    templateId: z.string(),
    version: z.number().int().positive(),
    contentFingerprint: z.string(),
    userPrompt: z.string(),
    systemPrompt: ReportTemplateSystemPromptSchema.optional(),
    trigger: ReportTriggerSchema.optional(),
    model: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    createdAt: z.coerce.date(),
  })
  .openapi("ReportTemplateVersionResponse");
