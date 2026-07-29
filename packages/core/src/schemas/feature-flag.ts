// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const FeatureFlagResponseSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    enabled: z.boolean(),
    updatedAt: z.coerce.date(),
  })
  .openapi("FeatureFlagResponse");

export const UpdateFeatureFlagInputSchema = z
  .object({
    enabled: z.boolean(),
  })
  .openapi("UpdateFeatureFlagInput");
