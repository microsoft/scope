// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { RunState } from "../types/types.js";

export type TaxonomyStatusValue =
  | "queued"
  | "processing"
  | "done"
  | "failed";

export interface TaxonomyHandlerSummary {
  status: TaxonomyStatusValue;
  updatedAt?: Date;
  error?: string;
  resultAvailable: boolean;
}

/** Derives the minimal UI summary from persisted exact-run fields only. */
export function taxonomyHandlerSummary(
  run: RunState | undefined,
): TaxonomyHandlerSummary | undefined {
  const handler = run?.handlerStatus?.["pp-taxonomy"];
  if (!handler) return undefined;
  return {
    status: handler.status,
    ...(handler.updatedAt ? { updatedAt: handler.updatedAt } : {}),
    ...(handler.error ? { error: handler.error } : {}),
    resultAvailable: Boolean(run?.taxonomyEvaluation),
  };
}
