// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** Service principal name the API maps to the model-scanner key. */
export const MODEL_SCANNER_SERVICE_NAME = "model-scanner";

/**
 * Service-auth headers for model-scanner calls to the Scope API.
 *
 * Returns the `X-Service-Name` / `X-Internal-Key` pair when
 * `SCOPE_INTERNAL_API_KEY` is set, otherwise no headers (anonymous, as before).
 */
export function serviceAuthHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const key = env.SCOPE_INTERNAL_API_KEY;
  if (!key) return {};
  return { "X-Service-Name": MODEL_SCANNER_SERVICE_NAME, "X-Internal-Key": key };
}
