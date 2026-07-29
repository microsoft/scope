// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { PromptFeatureConfig } from '@scope/core';
import { PromptFeatureProvider } from './prompt-feature-provider.js';

interface CacheEntry {
  value: PromptFeatureConfig;
  expiry: number;
  /** Timestamp of last access (for LRU eviction) */
  lastAccess: number;
}

interface AllCacheEntry {
  value: PromptFeatureConfig[];
  expiry: number;
}

/**
 * PromptFeatureProvider backed by the Scope REST API with LRU caching.
 *
 * Uses native fetch() (Node 22 built-in). Prompt features are fetched from the API
 * on demand and cached with a configurable TTL and max-size LRU policy.
 */
export class RestApiPromptFeatureProvider implements PromptFeatureProvider {
  private cache = new Map<string, CacheEntry>();
  private allCache: AllCacheEntry | null = null;

  private readonly apiUrl: string;
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(apiUrl: string, options?: { maxSize?: number; ttlMs?: number }) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.maxSize = options?.maxSize ?? 200;
    this.ttlMs = options?.ttlMs ?? 60_000; // 1 minute
  }

  async get(id: string): Promise<PromptFeatureConfig | undefined> {
    const cached = this.cache.get(id);
    if (cached && Date.now() < cached.expiry) {
      cached.lastAccess = Date.now();
      return cached.value;
    }

    const url = `${this.apiUrl}/api/v1/prompt-features/${encodeURIComponent(id)}`;
    const res = await fetch(url);

    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw new Error(`[RestApiPromptFeatureProvider] GET ${url} failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as Record<string, unknown>;
    const config = mapToPromptFeatureConfig(data);
    this.putCache(id, config);
    return config;
  }

  async getAll(): Promise<PromptFeatureConfig[]> {
    if (this.allCache && Date.now() < this.allCache.expiry) {
      return this.allCache.value;
    }

    const url = `${this.apiUrl}/api/v1/prompt-features`;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`[RestApiPromptFeatureProvider] GET ${url} failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as Record<string, unknown>[];
    const configs = data.map(mapToPromptFeatureConfig);

    this.allCache = { value: configs, expiry: Date.now() + this.ttlMs };
    for (const c of configs) {
      this.putCache(c.id, c);
    }

    return configs;
  }

  async has(id: string): Promise<boolean> {
    return (await this.get(id)) !== undefined;
  }

  async size(): Promise<number> {
    return (await this.getAll()).length;
  }

  /** Invalidate a single cached entry */
  invalidate(id: string): void {
    this.cache.delete(id);
  }

  /** Clear all caches */
  clear(): void {
    this.cache.clear();
    this.allCache = null;
  }

  private putCache(id: string, config: PromptFeatureConfig): void {
    this.evictIfNeeded();
    this.cache.set(id, {
      value: config,
      expiry: Date.now() + this.ttlMs,
      lastAccess: Date.now(),
    });
  }

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

function mapToPromptFeatureConfig(data: Record<string, unknown>): PromptFeatureConfig {
  return {
    id: String(data.id),
    prompt: String(data.prompt),
  };
}
