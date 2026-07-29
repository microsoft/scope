// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const KeyInputSchema = z
  .object({})
  .passthrough()
  .openapi("KeyInput");

export const KeyResponseSchema = z
  .object({})
  .passthrough()
  .openapi("KeyResponse");

export const ValidateKeyInputSchema = z
  .object({
    token: z.string(),
  })
  .openapi("ValidateKeyInput");
