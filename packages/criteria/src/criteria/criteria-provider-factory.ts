// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { join } from 'path';
import { CriteriaProvider } from './criteria-provider.js';
import { FileSystemCriteriaProvider } from './criteria-provider-fs.js';
import { RestApiCriteriaProvider } from './criteria-provider-api.js';

/**
 * Create a CriteriaProvider based on environment variables:
 *
 * 1. CRITERIA_API_URL is set → RestApiCriteriaProvider (production / K8s / docker-compose)
 * 2. CRITERIA_DIR is set     → FileSystemCriteriaProvider (explicit local path)
 * 3. Otherwise               → FileSystemCriteriaProvider with default ./config/criteria
 */
export function createCriteriaProvider(): CriteriaProvider {
  const apiUrl = process.env.CRITERIA_API_URL;
  if (apiUrl) {
    console.log(`[CriteriaProviderFactory] Using REST API provider: ${apiUrl}`);
    return new RestApiCriteriaProvider(apiUrl);
  }

  const criteriaDir = process.env.CRITERIA_DIR || join(process.cwd(), 'config', 'criteria');
  console.log(`[CriteriaProviderFactory] Using filesystem provider: ${criteriaDir}`);
  return new FileSystemCriteriaProvider(criteriaDir);
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let providerInstance: CriteriaProvider | null = null;

/**
 * Get (or create) the singleton CriteriaProvider.
 */
export function getCriteriaProvider(): CriteriaProvider {
  if (!providerInstance) {
    providerInstance = createCriteriaProvider();
  }
  return providerInstance;
}

/**
 * Reset the singleton (useful for testing or reconfiguration).
 */
export function resetCriteriaProvider(): void {
  providerInstance = null;
}
