// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const CreateCriteriaInputSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    prompt: z.string(),
    dependsOn: z.array(z.string()).optional(),
  })
  .openapi("CreateCriteriaInput");

export const UpdateCriteriaInputSchema = z
  .object({
    prompt: z.string().optional(),
    dependsOn: z.array(z.string()).optional(),
  })
  .openapi("UpdateCriteriaInput");

export const CriteriaResponseSchema = z
  .object({
    id: z.string(),
    prompt: z.string(),
    dependsOn: z.array(z.string()).optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
  })
  .openapi("CriteriaResponse");

export const CriteriaGraphNodeSchema = z
  .object({
    id: z.string(),
    prompt: z.string(),
    dependsOn: z.array(z.string()).optional(),
  })
  .openapi("CriteriaGraphNode");

export const CriteriaGraphEdgeSchema = z
  .object({
    from: z.string(),
    to: z.string(),
  })
  .openapi("CriteriaGraphEdge");

export const CriteriaGraphSchema = z
  .object({
    nodes: z.array(CriteriaGraphNodeSchema),
    edges: z.array(CriteriaGraphEdgeSchema),
  })
  .openapi("CriteriaGraph");
