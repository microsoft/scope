// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const TaxonomySourceTypeSchema = z.enum(["builtin", "user"]);
export const TaxonomyBusinessIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const TaxonomyRevisionRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*@r[1-9]\d*$/);

const RelativeElementPathSchema = z.string().superRefine((value, ctx) => {
  if (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.split(/[\\/]/).some((part) => part === "..")
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Element path must be relative and must not traverse parent directories",
    });
  }
});

export const TaxonomyElementReferenceSchema = z.union([
  z.object({ path: RelativeElementPathSchema }).strict(),
  z.object({ ref: TaxonomyRevisionRefSchema }).strict(),
]);

export const PortableTaxonomySchema = z
  .object({
    schema_version: z.literal("scope/taxonomy/v1"),
    id: TaxonomyBusinessIdSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    surfaces: z
      .array(
        z
          .object({
            id: TaxonomyBusinessIdSchema,
            label: z.string().min(1),
            description: z.string().min(1).optional(),
          })
          .strict(),
      )
      .max(100),
    elements: z.array(TaxonomyElementReferenceSchema).min(1).max(200),
  })
  .strict()
  .openapi("PortableTaxonomy");

export const PortableTaxonomyElementSchema = z
  .object({
    schema_version: z.literal("scope/taxonomy/v1").optional(),
    id: TaxonomyBusinessIdSchema,
    label: z.string().min(1),
    description: z.string().min(1).optional(),
    category_id: TaxonomyBusinessIdSchema.optional(),
    implementation: z.discriminatedUnion("type", [
      z.object({ type: z.literal("prompt"), prompt: z.string().min(1) }).strict(),
      z
        .object({
          type: z.literal("deterministic"),
          handler: z.string().min(1),
          config: z.unknown().optional(),
        })
        .strict(),
    ]),
    preconditions: z.record(z.string(), z.boolean()),
    output: z
      .object({
        evidence_roles: z.record(z.string(), z.unknown()),
        constraints: z.array(z.unknown()).optional(),
      })
      .strict(),
  })
  .strict()
  .openapi("PortableTaxonomyElement");

export const CreateTaxonomyInputSchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    id: TaxonomyBusinessIdSchema.optional(),
    description: z.string().max(4096).optional(),
    sourceType: TaxonomySourceTypeSchema.default("user"),
    creator: z.string().optional(),
    content: PortableTaxonomySchema,
  })
  .strict()
  .openapi("CreateTaxonomyInput");

export const CreateTaxonomyElementInputSchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    id: TaxonomyBusinessIdSchema.optional(),
    description: z.string().max(4096).optional(),
    sourceType: TaxonomySourceTypeSchema.default("user"),
    creator: z.string().optional(),
    content: PortableTaxonomyElementSchema,
  })
  .strict()
  .openapi("CreateTaxonomyElementInput");

export const UpdateTaxonomyMetadataInputSchema = z
  .object({
    name: z.string().trim().min(1).max(256).optional(),
    description: z.string().max(4096).optional(),
  })
  .strict()
  .openapi("UpdateTaxonomyMetadataInput");

export const CreateTaxonomyRevisionInputSchema = z
  .object({
    content: PortableTaxonomySchema,
    creator: z.string().optional(),
  })
  .strict()
  .openapi("CreateTaxonomyRevisionInput");

export const CreateTaxonomyElementRevisionInputSchema = z
  .object({
    content: PortableTaxonomyElementSchema,
    creator: z.string().optional(),
  })
  .strict()
  .openapi("CreateTaxonomyElementRevisionInput");

export const CopyBuiltinTaxonomyRevisionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    id: TaxonomyBusinessIdSchema.optional(),
    description: z.string().max(4096).optional(),
    creator: z.string().optional(),
  })
  .strict()
  .openapi("CopyBuiltinTaxonomyRevisionInput");

export const TaxonomyResponseSchema = z
  .object({
    _id: z.string(),
    projectId: z.string(),
    id: TaxonomyBusinessIdSchema,
    name: z.string(),
    description: z.string().optional(),
    sourceType: TaxonomySourceTypeSchema,
    revisionCounter: z.number().int().nonnegative(),
    latestRevisionId: z.string().optional(),
    latestRevision: z.number().int().positive().optional(),
    creator: z.string().optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
  })
  .openapi("TaxonomyResponse");

export const TaxonomyElementResponseSchema = TaxonomyResponseSchema.openapi(
  "TaxonomyElementResponse",
);

export const TaxonomyRevisionResponseSchema = PortableTaxonomySchema.extend({
  _id: z.string(),
  taxonomyId: z.string(),
  projectId: z.string(),
  sourceType: TaxonomySourceTypeSchema,
  revision: z.number().int().positive(),
  ref: TaxonomyRevisionRefSchema,
  contentSha256: z.string().length(64),
  creator: z.string().optional(),
  createdAt: z.coerce.date(),
}).openapi("TaxonomyRevisionResponse");

export const TaxonomyElementRevisionResponseSchema =
  PortableTaxonomyElementSchema.extend({
    _id: z.string(),
    elementId: z.string(),
    projectId: z.string(),
    sourceType: TaxonomySourceTypeSchema,
    revision: z.number().int().positive(),
    ref: TaxonomyRevisionRefSchema,
    contentSha256: z.string().length(64),
    creator: z.string().optional(),
    createdAt: z.coerce.date(),
  }).openapi("TaxonomyElementRevisionResponse");

export const TaxonomyListItemResponseSchema = TaxonomyResponseSchema.extend({
  ref: TaxonomyRevisionRefSchema,
  version: z.string(),
  elementCount: z.number().int().nonnegative(),
}).openapi("TaxonomyListItemResponse");

export const TaxonomyRevisionSummaryResponseSchema = z
  .object({
    _id: z.string(),
    revision: z.number().int().positive(),
    ref: TaxonomyRevisionRefSchema,
    version: z.string(),
    elementCount: z.number().int().nonnegative(),
    contentSha256: z.string().length(64),
    creator: z.string().optional(),
    createdAt: z.coerce.date(),
    isLatest: z.boolean(),
  })
  .strict()
  .openapi("TaxonomyRevisionSummaryResponse");

export const ResolvedTaxonomyElementResponseSchema = z
  .object({
    position: z.number().int().nonnegative(),
    root: TaxonomyElementResponseSchema,
    revision: TaxonomyElementRevisionResponseSchema,
  })
  .strict()
  .openapi("ResolvedTaxonomyElementResponse");

export const TaxonomyDetailResponseSchema = z
  .object({
    taxonomy: TaxonomyResponseSchema,
    selectedRevision: TaxonomyRevisionResponseSchema,
    revisions: z.array(TaxonomyRevisionSummaryResponseSchema),
    elements: z.array(ResolvedTaxonomyElementResponseSchema),
  })
  .strict()
  .openapi("TaxonomyDetailResponse");
