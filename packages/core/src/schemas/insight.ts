// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const CreateInsightInputSchema = z
  .object({
    title: z.string(),
    description: z.string(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    createdBy: z.enum(["agent", "user"]).optional(),
    sourceReportId: z.string().optional(),
  })
  .openapi("CreateInsightInput");

export const UpdateInsightInputSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .openapi("UpdateInsightInput");

export const InsightResponseSchema = z
  .object({
    _id: z.string(),
    title: z.string(),
    description: z.string(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    upvotes: z.number(),
    downvotes: z.number(),
    blocked: z.boolean(),
    referenceCount: z.number(),
    createdBy: z.enum(["agent", "user"]),
    sourceReportId: z.string().optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
  })
  .openapi("InsightResponse");
