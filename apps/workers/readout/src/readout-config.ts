// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** Provider-resolved model selection used when no readout model is configured. */
export const DEFAULT_READOUT_MODEL = "auto";

/** Resolves the readout model while preserving the explicit environment override. */
export function resolveReadoutModel(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.READOUT_MODEL || DEFAULT_READOUT_MODEL;
}
