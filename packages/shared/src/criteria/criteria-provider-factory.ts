// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { join } from 'path';
import { CriteriaProvider } from './criteria-provider.js';
import { FileSystemCriteriaProvider } from './criteria-provider-fs.js';
import { RestApiCriteriaProvider } from './criteria-provider-api.js';
import type { BearerProvider } from '../http/bearer.js';

/**
 * Create a CriteriaProvider based on environment variables:
 *
 * 1. CRITERIA_API_URL is set → RestApiCriteriaProvider (production / K8s / docker-compose)
 * 2. CRITERIA_DIR is set     → FileSystemCriteriaProvider (explicit local path)
 * 3. Otherwise               → FileSystemCriteriaProvider with default ./config/criteria
 *
 * When `projectId` is provided, a REST provider is bound to that project so its
 * criteria fetches are isolated (`?projectId=`); the filesystem provider ignores
 * it (single-tenant local config).
 *
 * `opts.bearer` attaches a caller credential (the run token) to REST reads.
 * Providers built with a bearer are per-evaluation and must not be cached.
 */
export function createCriteriaProvider(
  projectId?: string,
  opts?: { bearer?: BearerProvider },
): CriteriaProvider {
  const apiUrl = process.env.CRITERIA_API_URL;
  if (apiUrl) {
    console.log(`[CriteriaProviderFactory] Using REST API provider: ${apiUrl}${projectId ? ` (project ${projectId})` : ''}`);
    const options = { ...(projectId ? { projectId } : {}), ...(opts?.bearer ? { bearer: opts.bearer } : {}) };
    return new RestApiCriteriaProvider(apiUrl, Object.keys(options).length ? options : undefined);
  }

  const criteriaDir = process.env.CRITERIA_DIR || join(process.cwd(), 'config', 'criteria');
  console.log(`[CriteriaProviderFactory] Using filesystem provider: ${criteriaDir}`);
  return new FileSystemCriteriaProvider(criteriaDir);
}

// ---------------------------------------------------------------------------
// Singleton(s)
// ---------------------------------------------------------------------------

/**
 * Per-project (and global) provider cache. The judge evaluates one run at a time
 * against its run's project, so a small Map keyed by projectId (or '__global__'
 * when unscoped) gives each project its own provider + isolated LRU cache.
 */
const providerInstances = new Map<string, CriteriaProvider>();

/**
 * Get (or create) the CriteriaProvider for a project (or the global one when
 * `projectId` is omitted — legacy/unscoped callers and the filesystem provider).
 */
export function getCriteriaProvider(projectId?: string): CriteriaProvider {
  const key = projectId ?? '__global__';
  let instance = providerInstances.get(key);
  if (!instance) {
    instance = createCriteriaProvider(projectId);
    providerInstances.set(key, instance);
  }
  return instance;
}

/**
 * Reset the provider cache (useful for testing or reconfiguration).
 */
export function resetCriteriaProvider(): void {
  providerInstances.clear();
}
