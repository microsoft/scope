// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const AccountInputSchema = z
  .object({})
  .passthrough()
  .openapi("AccountInput");

export const AccountResponseSchema = z
  .object({})
  .passthrough()
  .openapi("AccountResponse");
