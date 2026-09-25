// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { ResourceBindingSpecSchema } from "./resource.js";

extendZodWithOpenApi(z);

export const CreateProfileInputSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().max(512).optional(),
    workerType: z.string(),
    model: z.string(),
    reasoningEffort: z.string().optional(),
    agentVersion: z.string().optional(),
    mcpServers: z.array(z.string()).optional(),
    skillRevisions: z.array(z.string()).optional(),
    resources: z.array(ResourceBindingSpecSchema).optional(),
    extensions: z.array(z.string()).optional(),
  })
  .openapi("CreateProfileInput");

export const UpdateProfileIdentitySchema = z
  .object({
    name: z.string().min(1).max(128).optional(),
    description: z.string().max(512).optional(),
  })
  .openapi("UpdateProfileIdentity");

export const ProfileResponseSchema = z
  .object({
    _id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    latestVersion: z.number(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
    projectId: z.string(),
  })
  .openapi("ProfileResponse");

export const ProfileVersionResponseSchema = z
  .object({
    _id: z.string(),
    profileId: z.string(),
    version: z.number(),
    workerType: z.string(),
    model: z.string(),
    reasoningEffort: z.string().optional(),
    agentVersion: z.string().optional(),
    mcpServers: z.array(z.string()).optional(),
    skillRevisions: z.array(z.string()).optional(),
    resources: z.array(ResourceBindingSpecSchema).optional(),
    extensions: z.array(z.string()).optional(),
    createdAt: z.coerce.date(),
    projectId: z.string(),
  })
  .openapi("ProfileVersionResponse");

export const ProfileWithVersionResponseSchema = z
  .object({
    _id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    latestVersion: z.number(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
    version: ProfileVersionResponseSchema,
    projectId: z.string(),
  })
  .openapi("ProfileWithVersionResponse");
