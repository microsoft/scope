// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { GATES, CRITERION_KINDS, CRITERION_SUBJECTS, TAXONOMY_ELEMENT_IDS } from "../types/types.js";

extendZodWithOpenApi(z);

export const GateIdSchema = z.enum(GATES);
export const CriterionKindSchema = z.enum(CRITERION_KINDS);
export const CriterionSubjectSchema = z.enum(CRITERION_SUBJECTS);
export const TaxonomyElementIdSchema = z.enum(TAXONOMY_ELEMENT_IDS);

export const CreateCriteriaInputSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    prompt: z.string(),
    dependsOn: z.array(z.string()).optional(),
    gates: z.array(GateIdSchema).optional(),
    kind: CriterionKindSchema.default("gate"),
    taxonomyElementId: TaxonomyElementIdSchema.optional(),
    subject: CriterionSubjectSchema.optional(),
  })
  .openapi("CreateCriteriaInput");

export const UpdateCriteriaInputSchema = z
  .object({
    prompt: z.string().optional(),
    dependsOn: z.array(z.string()).optional(),
    gates: z.array(GateIdSchema).optional(),
    kind: CriterionKindSchema.optional(),
    taxonomyElementId: TaxonomyElementIdSchema.optional(),
    subject: CriterionSubjectSchema.optional(),
  })
  .openapi("UpdateCriteriaInput");

export const CriteriaResponseSchema = z
  .object({
    id: z.string(),
    prompt: z.string(),
    dependsOn: z.array(z.string()).optional(),
    gates: z.array(GateIdSchema).optional(),
    kind: CriterionKindSchema.optional(),
    taxonomyElementId: TaxonomyElementIdSchema.optional(),
    subject: CriterionSubjectSchema.optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
    projectId: z.string(),
  })
  .openapi("CriteriaResponse");

export const CriteriaGraphNodeSchema = z
  .object({
    id: z.string(),
    prompt: z.string(),
    dependsOn: z.array(z.string()).optional(),
    gates: z.array(GateIdSchema).optional(),
    kind: CriterionKindSchema.optional(),
    taxonomyElementId: TaxonomyElementIdSchema.optional(),
    subject: CriterionSubjectSchema.optional(),
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
