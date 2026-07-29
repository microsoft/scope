// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { CriteriaConfig } from '@scope/core';
import { CriteriaProvider } from './criteria-provider.js';

interface CacheEntry {
  value: CriteriaConfig;
  expiry: number;
  /** Timestamp of last access (for LRU eviction) */
  lastAccess: number;
}

interface AllCacheEntry {
  value: CriteriaConfig[];
  expiry: number;
}

/**
 * CriteriaProvider backed by the Scope REST API with LRU caching.
 *
 * Uses native fetch() (Node 22 built-in). Criteria are fetched from the API
 * on demand and cached with a configurable TTL and max-size LRU policy.
 *
 * For `resolveWithAncestors`, we optimise by fetching ALL criteria once
 * (using allCache) and resolving the DAG locally — one HTTP request instead
 * of potentially many individual GETs.
 */
export class RestApiCriteriaProvider implements CriteriaProvider {
  private cache = new Map<string, CacheEntry>();
  private allCache: AllCacheEntry | null = null;

  private readonly apiUrl: string;
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(apiUrl: string, options?: { maxSize?: number; ttlMs?: number }) {
    // Strip trailing slash
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.maxSize = options?.maxSize ?? 200;
    this.ttlMs = options?.ttlMs ?? 60_000; // 1 minute
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async get(id: string): Promise<CriteriaConfig | undefined> {
    // 1. Check individual cache
    const cached = this.cache.get(id);
    if (cached && Date.now() < cached.expiry) {
      cached.lastAccess = Date.now();
      return cached.value;
    }

    // 2. Fetch from API
    const url = `${this.apiUrl}/api/v1/criteria/${encodeURIComponent(id)}`;
    const res = await fetch(url);

    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw new Error(`[RestApiCriteriaProvider] GET ${url} failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as Record<string, unknown>;
    const config = mapToCriteriaConfig(data);

    this.putCache(id, config);
    return config;
  }

  async getAll(): Promise<CriteriaConfig[]> {
    // 1. Check allCache
    if (this.allCache && Date.now() < this.allCache.expiry) {
      return this.allCache.value;
    }

    // 2. Fetch from API
    const url = `${this.apiUrl}/api/v1/criteria`;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`[RestApiCriteriaProvider] GET ${url} failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as Record<string, unknown>[];
    const configs = data.map(mapToCriteriaConfig);

    this.allCache = { value: configs, expiry: Date.now() + this.ttlMs };

    // Also populate individual cache entries
    for (const c of configs) {
      this.putCache(c.id, c);
    }

    return configs;
  }

  async resolveWithAncestors(ids: string[]): Promise<CriteriaConfig[]> {
    // Optimisation: fetch ALL criteria once, then resolve the DAG locally.
    // One HTTP request instead of N individual GETs.
    const all = await this.getAll();
    const index = new Map<string, CriteriaConfig>();
    for (const c of all) {
      index.set(c.id, c);
    }

    const collected = new Map<string, CriteriaConfig>();
    const queue = [...ids];

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (collected.has(id)) continue;

      const criteria = index.get(id);
      if (!criteria) {
        const availableIds = Array.from(index.keys()).join(', ');
        throw new Error(
          `Criteria '${id}' not found via API. Available criteria: ${availableIds || 'none'}`
        );
      }
      collected.set(id, criteria);

      if (criteria.dependsOn) {
        for (const parentId of criteria.dependsOn) {
          if (!collected.has(parentId)) {
            queue.push(parentId);
          }
        }
      }
    }

    return Array.from(collected.values());
  }

  async has(id: string): Promise<boolean> {
    return (await this.get(id)) !== undefined;
  }

  async size(): Promise<number> {
    return (await this.getAll()).length;
  }

  // ---------------------------------------------------------------------------
  // Cache management
  // ---------------------------------------------------------------------------

  /** Invalidate a single cached criterion */
  invalidate(id: string): void {
    this.cache.delete(id);
  }

  /** Clear all caches */
  clear(): void {
    this.cache.clear();
    this.allCache = null;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private putCache(id: string, config: CriteriaConfig): void {
    this.evictIfNeeded();
    this.cache.set(id, {
      value: config,
      expiry: Date.now() + this.ttlMs,
      lastAccess: Date.now(),
    });
  }

  /**
   * LRU eviction: if cache exceeds maxSize, remove the least recently accessed
   * entry (lowest lastAccess timestamp).
   */
  private evictIfNeeded(): void {
    if (this.cache.size < this.maxSize) return;

    let oldestKey: string | null = null;
    let oldestAccess = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }
}

// ---------------------------------------------------------------------------
// Mapping helper
// ---------------------------------------------------------------------------

/**
 * Map an API response object to a CriteriaConfig, stripping DB metadata
 * (createdAt, updatedAt, deletedAt, dependents, _id, etc.)
 */
function mapToCriteriaConfig(data: Record<string, unknown>): CriteriaConfig {
  const dependsOn = (data.dependsOn as string[] | undefined) ?? [];
  return {
    id: String(data.id),
    prompt: String(data.prompt),
    dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
  };
}
