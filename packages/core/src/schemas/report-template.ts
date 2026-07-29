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

export const ReportTriggerSchema = z
  .discriminatedUnion("type", [
    AlwaysTriggerSchema,
    CriteriaTriggerSchema,
    TaskPromptTriggerSchema,
    PromptFeatureTriggerSchema,
  ])
  .openapi("ReportTrigger");

export const ReportTemplateSystemPromptSchema = z
  .object({
    mode: z.enum(["append", "override"]),
    content: z.string(),
  })
  .openapi("ReportTemplateSystemPrompt");

export const CreateReportTemplateInputSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    userPrompt: z.string(),
    systemPrompt: ReportTemplateSystemPromptSchema.optional(),
    trigger: ReportTriggerSchema.optional(),
    model: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
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
  })
  .openapi("UpdateReportTemplateInput");

export const ReportTemplateResponseSchema = z
  .object({
    _id: z.string(),
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    userPrompt: z.string(),
    systemPrompt: ReportTemplateSystemPromptSchema.optional(),
    trigger: ReportTriggerSchema.optional(),
    model: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
  })
  .openapi("ReportTemplateResponse");
