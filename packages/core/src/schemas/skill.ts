// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const SkillOriginSchema = z.enum(["skills-sh", "manual"]);

export const CreateSkillInputSchema = z
  .object({
    source: z.string(),
    skillName: z.string(),
    name: z.string(),
    description: z.string().optional(),
    origin: SkillOriginSchema,
  })
  .openapi("CreateSkillInput");

export const SkillResponseSchema = z
  .object({
    _id: z.string(),
    source: z.string(),
    skillName: z.string(),
    name: z.string(),
    description: z.string().optional(),
    origin: SkillOriginSchema,
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
  })
  .openapi("SkillResponse");

export const SkillRevisionResponseSchema = z
  .object({
    _id: z.string(),
    ref: z.string(),
    source: z.string(),
    skillName: z.string(),
    skillPath: z.string(),
    commitHash: z.string(),
    commitTimestamp: z.coerce.date(),
    name: z.string(),
    description: z.string(),
    license: z.string().optional(),
    compatibility: z.string().optional(),
    allowedTools: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    content: z.string(),
    archiveUrl: z.string(),
    validationWarnings: z.array(z.string()).optional(),
    resolvedAt: z.coerce.date(),
    createdAt: z.coerce.date(),
  })
  .openapi("SkillRevisionResponse");

export const SkillSearchResultSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    source: z.string(),
    description: z.string().optional(),
    internal: z.boolean(),
    installs: z.number().optional(),
  })
  .openapi("SkillSearchResult");

export const SkillDiscoveryResultSchema = z
  .object({
    skillName: z.string(),
    skillPath: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    existsInLibrary: z.boolean().optional(),
    currentRevisionCommitSha: z.string().optional(),
    latestUpstreamCommitSha: z.string().optional(),
    updateAvailable: z.boolean().optional(),
    lastImportedAt: z.string().optional(),
  })
  .openapi("SkillDiscoveryResult");
