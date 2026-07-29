// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { PromptFeatureResultSchema } from "./prompt-feature.js";

extendZodWithOpenApi(z);

export const CreateTaskPromptInputSchema = z
  .object({
    text: z.string(),
  })
  .openapi("CreateTaskPromptInput");

export const TaskPromptResponseSchema = z
  .object({
    _id: z.string(),
    text: z.string(),
    features: z.array(PromptFeatureResultSchema).optional(),
    featuresExtractedAt: z.coerce.date().optional(),
    createdAt: z.coerce.date(),
    deletedAt: z.coerce.date().optional(),
  })
  .openapi("TaskPromptResponse");

export const PatchTaskPromptFeatureInputSchema = z
  .object({
    detected: z.boolean(),
  })
  .openapi("PatchTaskPromptFeatureInput");
