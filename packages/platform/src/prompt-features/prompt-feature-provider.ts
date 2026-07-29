// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { PromptFeatureConfig } from '@scope/core';

/**
 * Unified interface for loading prompt features from different sources.
 *
 * Implementations:
 * - FileSystemPromptFeatureProvider: reads YAML from a directory (local dev)
 * - RestApiPromptFeatureProvider:    fetches from the REST API with LRU caching (production)
 *
 * All methods are async so both sync (FS) and async (HTTP) backends work
 * behind the same contract.
 */
export interface PromptFeatureProvider {
  /** Get a single prompt feature by ID */
  get(id: string): Promise<PromptFeatureConfig | undefined>;

  /** Get all prompt features */
  getAll(): Promise<PromptFeatureConfig[]>;

  /** Check if a prompt feature exists */
  has(id: string): Promise<boolean>;

  /** Number of known prompt features */
  size(): Promise<number>;
}
