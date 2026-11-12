// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { RunState } from "../types/types.js";

export type TaxonomyStatusValue =
  | "pending"
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
  taxonomyExpected = false,
): TaxonomyHandlerSummary | undefined {
  const handler = run?.handlerStatus?.["pp-taxonomy"];
  if (!handler) {
    return taxonomyExpected
      ? { status: "pending", resultAvailable: false }
      : undefined;
  }
  return {
    status: handler.status,
    ...(handler.updatedAt ? { updatedAt: handler.updatedAt } : {}),
    ...(handler.error ? { error: handler.error } : {}),
    resultAvailable: Boolean(run?.taxonomyEvaluation),
  };
}
