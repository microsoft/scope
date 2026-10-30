// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** Provider-resolved model selection used when no report model is configured. */
export const DEFAULT_REPORT_MODEL = "auto";

/** Resolves the report model while preserving the explicit environment override. */
export function resolveReportModel(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.REPORT_MODEL || DEFAULT_REPORT_MODEL;
}
