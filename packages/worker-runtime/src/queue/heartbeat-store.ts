// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const Redis = require("ioredis");

import type { RedisConfig } from "../logging/log-publisher.js";

/**
 * Per-run liveness heartbeat storage.
 *
 * Workers `set` a fresh timestamp every {@link HEARTBEAT_INTERVAL_MS}
 * while a run is `processing`. The redelivery handler `get`s it to
 * decide whether a duplicate queue message represents a real worker
 * crash (stale / missing) or a spurious redelivery (fresh).
 *
 * Implementations must be tolerant of transient backend failures —
 * losing one heartbeat write must not crash the worker. Errors are
 * swallowed (and logged) by the Redis-backed implementation; tests
 * can use {@link InMemoryHeartbeatStore} to inspect calls deterministically.
 */
export interface HeartbeatStore {
  set(runId: string, ts: Date): Promise<void>;
  get(runId: string): Promise<Date | null>;
  /** Batch read for API enrichment. Missing keys are simply absent from the map. */
  mget(runIds: string[]): Promise<Map<string, Date>>;
  delete(runId: string): Promise<void>;
  close(): Promise<void>;

  // --- Cancellation signal ---

  /** Set a cancel signal for a run (key + pub/sub publish). */
  setCancelled(runId: string): Promise<void>;
  /** Check if a cancel signal exists for a run (key-based fallback). */
  isCancelled(runId: string): Promise<boolean>;
  /** Delete the cancel signal key (cleanup after detection). */
  deleteCancelled(runId: string): Promise<void>;
  /**
   * Subscribe to the cancel channel for a specific run.
   * Calls `onCancel` when a cancel message is received.
   * Returns an unsubscribe function.
   */
  subscribeCancellation(runId: string, onCancel: () => void): () => void;
}

/** Default TTL is 5x the visibility timeout (60s) → 5 minutes. Configurable via env. */
export const DEFAULT_HEARTBEAT_TTL_MS = 5 * 60 * 1000;

/** Redis key prefix. Spelled out for readability when debugging via redis-cli. */
const KEY_PREFIX = "run-heartbeat:";

/** Redis key prefix for cancel signals. */
const CANCEL_KEY_PREFIX = "run-cancelled:";

/** Redis pub/sub channel prefix for instant cancel notifications. */
const CANCEL_CHANNEL_PREFIX = "run-cancel:";

/** TTL for cancel keys — 1 hour. Long enough for any dead worker scenario. */
const CANCEL_KEY_TTL_MS = 60 * 60 * 1000;

const keyFor = (runId: string) => `${KEY_PREFIX}${runId}`;
const cancelKeyFor = (runId: string) => `${CANCEL_KEY_PREFIX}${runId}`;
const cancelChannelFor = (runId: string) => `${CANCEL_CHANNEL_PREFIX}${runId}`;

export interface RedisHeartbeatStoreOptions {
  ttlMs?: number;
}

export class RedisHeartbeatStore implements HeartbeatStore {
  private readonly redis: any;
  private subscriber: any | null = null;
  private readonly redisConfig: RedisConfig;
  private readonly ttlMs: number;
  private warnedOnError = false;

  constructor(config: RedisConfig, options: RedisHeartbeatStoreOptions = {}) {
    this.redisConfig = config;
    this.ttlMs = options.ttlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
    const useTls =
      process.env.REDIS_TLS === "true" ||
      (config.redisPassword &&
        config.redisHost !== "localhost" &&
        config.redisHost !== "127.0.0.1" &&
        config.redisHost !== "redis");
    this.redis = new Redis({
      host: config.redisHost,
      port: config.redisPort,
      password: config.redisPassword || undefined,
      ...(useTls ? { tls: { rejectUnauthorized: false } } : {}),
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 1000, 3000)),
    });
    this.redis.on("error", (err: Error) => {
      // Throttle the warning so a sustained outage doesn't spam logs.
      if (!this.warnedOnError) {
        console.warn("[heartbeat-store] Redis error:", err.message);
        this.warnedOnError = true;
        setTimeout(() => {
          this.warnedOnError = false;
        }, 60_000);
      }
    });
  }

  /** Lazily create a dedicated subscriber connection (ioredis can't mix subscriptions with commands). */
  private getSubscriber(): any {
    if (!this.subscriber) {
      const useTls =
        process.env.REDIS_TLS === "true" ||
        (this.redisConfig.redisPassword &&
          this.redisConfig.redisHost !== "localhost" &&
          this.redisConfig.redisHost !== "127.0.0.1" &&
          this.redisConfig.redisHost !== "redis");
      this.subscriber = new Redis({
        host: this.redisConfig.redisHost,
        port: this.redisConfig.redisPort,
        password: this.redisConfig.redisPassword || undefined,
        ...(useTls ? { tls: { rejectUnauthorized: false } } : {}),
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 1000, 3000)),
      });
      this.subscriber.on("error", (err: Error) => {
        console.warn("[heartbeat-store] Subscriber Redis error:", err.message);
      });
    }
    return this.subscriber;
  }

  async set(runId: string, ts: Date): Promise<void> {
    try {
      await this.redis.set(keyFor(runId), ts.toISOString(), "PX", this.ttlMs);
    } catch (err) {
      console.warn(`[heartbeat-store] set ${runId} failed:`, (err as Error).message);
    }
  }

  async get(runId: string): Promise<Date | null> {
    try {
      const v = await this.redis.get(keyFor(runId));
      if (!v) return null;
      const ms = Date.parse(v);
      return Number.isFinite(ms) ? new Date(ms) : null;
    } catch (err) {
      console.warn(`[heartbeat-store] get ${runId} failed:`, (err as Error).message);
      return null;
    }
  }

  async mget(runIds: string[]): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    if (runIds.length === 0) return out;
    try {
      const vals: (string | null)[] = await this.redis.mget(runIds.map(keyFor));
      vals.forEach((v, i) => {
        if (!v) return;
        const ms = Date.parse(v);
        if (Number.isFinite(ms)) out.set(runIds[i], new Date(ms));
      });
    } catch (err) {
      console.warn(`[heartbeat-store] mget failed:`, (err as Error).message);
    }
    return out;
  }

  async delete(runId: string): Promise<void> {
    try {
      await this.redis.del(keyFor(runId));
    } catch (err) {
      console.warn(`[heartbeat-store] delete ${runId} failed:`, (err as Error).message);
    }
  }

  async close(): Promise<void> {
    try {
      if (this.subscriber) {
        await this.subscriber.quit().catch(() => this.subscriber?.disconnect());
        this.subscriber = null;
      }
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  async setCancelled(runId: string): Promise<void> {
    try {
      await this.redis.set(cancelKeyFor(runId), "1", "PX", CANCEL_KEY_TTL_MS);
      await this.redis.publish(cancelChannelFor(runId), "cancel");
    } catch (err) {
      console.warn(`[heartbeat-store] setCancelled ${runId} failed:`, (err as Error).message);
    }
  }

  async isCancelled(runId: string): Promise<boolean> {
    try {
      const v = await this.redis.get(cancelKeyFor(runId));
      return v !== null;
    } catch (err) {
      console.warn(`[heartbeat-store] isCancelled ${runId} failed:`, (err as Error).message);
      return false;
    }
  }

  async deleteCancelled(runId: string): Promise<void> {
    try {
      await this.redis.del(cancelKeyFor(runId));
    } catch (err) {
      console.warn(`[heartbeat-store] deleteCancelled ${runId} failed:`, (err as Error).message);
    }
  }

  subscribeCancellation(runId: string, onCancel: () => void): () => void {
    const channel = cancelChannelFor(runId);
    const sub = this.getSubscriber();
    let active = true;

    const handler = (ch: string) => {
      if (ch === channel && active) {
        onCancel();
      }
    };
    sub.subscribe(channel).catch((err: Error) => {
      console.warn(`[heartbeat-store] subscribe ${channel} failed:`, err.message);
    });
    sub.on("message", handler);

    return () => {
      if (!active) return;
      active = false;
      sub.unsubscribe(channel).catch(() => {});
      sub.removeListener("message", handler);
    };
  }
}

/**
 * In-memory implementation for tests. Honors TTL via stored expiry timestamps
 * so tests can assert TTL semantics if they care to.
 */
export class InMemoryHeartbeatStore implements HeartbeatStore {
  private readonly map = new Map<string, { ts: Date; expiresAt: number }>();
  private readonly cancelledSet = new Set<string>();
  private readonly cancelListeners = new Map<string, Set<() => void>>();
  private readonly ttlMs: number;

  constructor(options: RedisHeartbeatStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.map) if (v.expiresAt <= now) this.map.delete(k);
  }

  async set(runId: string, ts: Date): Promise<void> {
    this.map.set(runId, { ts, expiresAt: Date.now() + this.ttlMs });
  }

  async get(runId: string): Promise<Date | null> {
    this.prune();
    return this.map.get(runId)?.ts ?? null;
  }

  async mget(runIds: string[]): Promise<Map<string, Date>> {
    this.prune();
    const out = new Map<string, Date>();
    for (const id of runIds) {
      const v = this.map.get(id);
      if (v) out.set(id, v.ts);
    }
    return out;
  }

  async delete(runId: string): Promise<void> {
    this.map.delete(runId);
  }

  async close(): Promise<void> {
    this.map.clear();
    this.cancelledSet.clear();
    this.cancelListeners.clear();
  }

  async setCancelled(runId: string): Promise<void> {
    this.cancelledSet.add(runId);
    const listeners = this.cancelListeners.get(runId);
    if (listeners) {
      for (const cb of listeners) cb();
    }
  }

  async isCancelled(runId: string): Promise<boolean> {
    return this.cancelledSet.has(runId);
  }

  async deleteCancelled(runId: string): Promise<void> {
    this.cancelledSet.delete(runId);
  }

  subscribeCancellation(runId: string, onCancel: () => void): () => void {
    if (!this.cancelListeners.has(runId)) {
      this.cancelListeners.set(runId, new Set());
    }
    this.cancelListeners.get(runId)!.add(onCancel);
    return () => {
      const set = this.cancelListeners.get(runId);
      if (set) {
        set.delete(onCancel);
        if (set.size === 0) this.cancelListeners.delete(runId);
      }
    };
  }
}
