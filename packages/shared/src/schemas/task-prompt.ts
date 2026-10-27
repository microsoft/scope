// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { PromptFeatureResultSchema } from "./prompt-feature.js";
import { PromptTypeSchema } from "./prompt-type.js";

extendZodWithOpenApi(z);

export { PromptTypeSchema };

/** Longest accepted task prompt name, in characters. */
export const TASK_PROMPT_NAME_MAX_LENGTH = 100;

/**
 * A task prompt's human-readable name: trimmed, 1–100 characters. Free-form,
 * so both slugs (`"ecommerce-order-api"`) and phrases work.
 */
export const TaskPromptNameSchema = z
  .string()
  .trim()
  .min(1, "name must not be empty")
  .max(TASK_PROMPT_NAME_MAX_LENGTH, `name must be at most ${TASK_PROMPT_NAME_MAX_LENGTH} characters`);

export const CreateTaskPromptInputSchema = z
  .object({
    text: z.string(),
    type: PromptTypeSchema.optional(),
    /** Optional label; applied on create, or to an existing match that has no name yet. */
    name: TaskPromptNameSchema.optional(),
  })
  .openapi("CreateTaskPromptInput");

/** Body of `PATCH /task-prompts/:id`: set the name, or clear it with `null`. */
export const UpdateTaskPromptInputSchema = z
  .object({
    name: TaskPromptNameSchema.nullable(),
  })
  .openapi("UpdateTaskPromptInput");

export const TaskPromptResponseSchema = z
  .object({
    _id: z.string(),
    keyId: z.string(),
    name: z.string().optional(),
    type: PromptTypeSchema.optional(),
    // Present for inline-stored bodies; absent when the body lives in blob
    // storage (see `contentBlobUrl`). Use the `/content` endpoint to always
    // get the resolved text.
    text: z.string().optional(),
    contentBlobUrl: z.string().optional(),
    features: z.array(PromptFeatureResultSchema).optional(),
    featuresExtractedAt: z.coerce.date().optional(),
    createdAt: z.coerce.date(),
    deletedAt: z.coerce.date().optional(),
    projectId: z.string(),
  })
  .openapi("TaskPromptResponse");

export const PatchTaskPromptFeatureInputSchema = z
  .object({
    detected: z.boolean(),
  })
  .openapi("PatchTaskPromptFeatureInput");
