// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { stripTrailingSlashes } from "shared/strings";

/**
 * Wait for the API server to become healthy.
 *
 * Retries GET /health every `intervalMs` until it gets a 2xx response
 * or the maximum number of retries is reached.
 */
export async function waitForApi(
  apiUrl: string,
  options?: { maxRetries?: number; intervalMs?: number },
): Promise<void> {
  const maxRetries = options?.maxRetries ?? 60;
  const intervalMs = options?.intervalMs ?? 5_000;
  const healthUrl = `${stripTrailingSlashes(apiUrl)}/health`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        console.log(`API is ready (attempt ${attempt}).`);
        return;
      }
    } catch {
      // ignore — API not ready yet
    }
    if (attempt < maxRetries) {
      console.log(
        `API not ready, retrying in ${intervalMs / 1000}s... (attempt ${attempt}/${maxRetries})`,
      );
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw new Error(
    `API did not become healthy after ${maxRetries} attempts at ${healthUrl}`,
  );
}
