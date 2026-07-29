// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const ModelResponseSchema = z
  .object({
    _id: z.string(),
    modelId: z.string(),
    provider: z.string(),
    agentId: z.string(),
    firstSeenAt: z.coerce.date(),
    lastSeenAt: z.coerce.date(),
    disappearedAt: z.coerce.date().optional(),
    providerAvailableFrom: z.coerce.date().optional(),
    providerEndOfLife: z.coerce.date().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("ModelResponse");

export const ModelSyncInputSchema = z
  .object({
    models: z.array(
      z.object({
        modelId: z.string(),
        provider: z.string(),
        agentId: z.string(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
  })
  .openapi("ModelSyncInput");

export const ListModelsQuerySchema = z
  .object({
    agentId: z.string().optional(),
    provider: z.string().optional(),
  })
  .openapi("ListModelsQuery");
