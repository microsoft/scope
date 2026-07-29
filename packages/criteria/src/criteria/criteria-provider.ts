// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { CriteriaConfig } from '@scope/core';

/**
 * Unified interface for loading criteria from different sources.
 *
 * Implementations:
 * - FileSystemCriteriaProvider: reads YAML from a directory (backward compat / local dev)
 * - RestApiCriteriaProvider:    fetches from the REST API with LRU caching (production)
 *
 * All methods are async so both sync (FS) and async (HTTP) backends work
 * behind the same contract.
 */
export interface CriteriaProvider {
  /** Get a single criterion by ID */
  get(id: string): Promise<CriteriaConfig | undefined>;

  /** Get all criteria */
  getAll(): Promise<CriteriaConfig[]>;

  /**
   * Resolve criteria IDs including transitive ancestors (BFS).
   * Ensures the full DAG is available for DependencyGraph construction.
   * Throws if any criterion (leaf or ancestor) is missing.
   */
  resolveWithAncestors(ids: string[]): Promise<CriteriaConfig[]>;

  /** Check if a criterion exists */
  has(id: string): Promise<boolean>;

  /** Number of known criteria */
  size(): Promise<number>;
}
