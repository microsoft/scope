// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const ExtensionOriginSchema = z.enum(["marketplace", "manual"]);

export const CreateExtensionInputSchema = z
  .object({
    _id: z.string().regex(/^[a-zA-Z0-9-]+\.[a-zA-Z0-9-]+$/),
    publisher: z.string(),
    name: z.string(),
    description: z.string().optional(),
    origin: ExtensionOriginSchema,
  })
  .openapi("CreateExtensionInput");

export const UpdateExtensionInputSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
  })
  .openapi("UpdateExtensionInput");

export const ExtensionResponseSchema = z
  .object({
    _id: z.string(),
    publisher: z.string(),
    name: z.string(),
    description: z.string().optional(),
    origin: ExtensionOriginSchema,
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
  })
  .openapi("ExtensionResponse");

export const ExtensionSearchResultSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    publisher: z.string(),
    description: z.string().optional(),
    internal: z.boolean(),
    version: z.string().optional(),
  })
  .openapi("ExtensionSearchResult");

export const ExtensionVersionInfoSchema = z
  .object({
    version: z.string(),
    preRelease: z.boolean(),
    lastUpdated: z.string(),
  })
  .openapi("ExtensionVersionInfo");
