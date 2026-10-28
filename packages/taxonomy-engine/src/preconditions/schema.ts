// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";

/** Closed element precondition configuration; every rule defaults off. */
export const preconditionsSchema = z.object({
  requires_complete_trajectory: z.boolean().default(false),
  requires_task: z.boolean().default(false),
  requires_recorded_discovery: z.boolean().default(false),
}).strict().default({});

export type ElementPreconditions = z.infer<typeof preconditionsSchema>;
