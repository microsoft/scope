// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const Redis = require("ioredis");
import { circuitBreaker, handleAll, ConsecutiveBreaker, CircuitState } from "cockatiel";
import { LogEvent } from "@scope/core";
import { BlobStorage } from "@scope/platform";

export interface RedisConfig {
  redisHost: string;
  redisPort: number;
  redisPassword: string;
}

export type LogPublisherConfig = RedisConfig;

export class LogPublisher {
  private redis: InstanceType<typeof Redis>;
  private blobStorage: BlobStorage;
  private source: string;
  private redisBreaker = circuitBreaker(handleAll, {
    halfOpenAfter: 60_000, // Try again after 1 minute
    breaker: new ConsecutiveBreaker(3), // Open after 3 consecutive failures
  });

  constructor(config: LogPublisherConfig, blobStorage: BlobStorage, source: string = "coder") {
    // Support both local Redis (no TLS) and Azure Redis (TLS)
    // Use REDIS_TLS env var if set, otherwise infer from password + non-localhost host
    const useTls = process.env.REDIS_TLS === "true" ||
      (config.redisPassword && config.redisHost !== "localhost" && config.redisHost !== "127.0.0.1" && config.redisHost !== "redis");
    this.redis = new Redis({
      host: config.redisHost,
      port: config.redisPort,
      password: config.redisPassword || undefined,
      ...(useTls ? { tls: { rejectUnauthorized: false } } : {}),
      // Limit reconnection attempts to avoid log spam
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 3) {
          // Stop retrying after 3 attempts
          return null;
        }
        return Math.min(times * 1000, 3000); // Exponential backoff, max 3s
      },
    });
    this.blobStorage = blobStorage;
    this.source = source;

    // Handle ioredis errors to prevent "Unhandled error event" spam
    this.redis.on("error", (err: Error) => {
      // Only log once when circuit breaker is not already open
      if (this.redisBreaker.state === CircuitState.Closed) {
        console.error("Redis connection error:", err.message);
      }
    });

    // Log circuit breaker state changes
    this.redisBreaker.onStateChange((state) => {
      if (state === CircuitState.Open) {
        console.error("Redis circuit breaker OPEN - stopping Redis publish attempts for 1 minute");
      } else if (state === CircuitState.HalfOpen) {
        console.log("Redis circuit breaker HALF-OPEN - testing connection");
      } else if (state === CircuitState.Closed) {
        console.log("Redis circuit breaker CLOSED - connection restored");
      }
    });
  }

  async publish(
    requestId: string,
    runId: string,
    level: LogEvent["level"],
    message: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    const logEvent: LogEvent = {
      timestamp: new Date().toISOString(),
      level,
      source: this.source,
      message,
      data,
    };

    // Publish to Redis for real-time streaming (with circuit breaker).
    // The Redis channel is keyed on requestId so SSE listeners receive logs
    // for whichever attempt is currently running.
    const channel = `logs:${requestId}`;
    try {
      await this.redisBreaker.execute(() =>
        this.redis.publish(channel, JSON.stringify(logEvent))
      );
    } catch (error) {
      // Silently ignore - circuit breaker handles logging state changes
    }

    // Append to blob storage for persistence (avoids CosmosDB RU pressure).
    // Per-attempt path: {requestId}/runs/{runId}/run.jsonl
    // The Azure SDK's built-in StorageRetryPolicy handles transient failures
    // (429, 500, 503, network errors) with exponential backoff — default: 3 attempts.
    try {
      await this.blobStorage.appendLogEvent(requestId, runId, logEvent);
    } catch (error) {
      console.error(`Failed to persist log to blob storage: ${error}`);
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  /**
   * Clears the per-run blob initialisation cache entry once a run is complete.
   * Prevents the map from growing unbounded in long-lived worker processes.
   */
  evictRun(requestId: string, runId: string): void {
    this.blobStorage.evictRun(requestId, runId);
  }
}

/**
 * Lightweight Redis-only log publisher for services that don't own blob-storage persistence.
 * Used by the judge service to publish real-time criterion evaluation progress.
 * Workers persist logs to blob storage via the full LogPublisher — this only publishes to Redis.
 */
export class RedisLogPublisher {
  private redis: InstanceType<typeof Redis>;
  private source: string;
  private redisBreaker = circuitBreaker(handleAll, {
    halfOpenAfter: 60_000,
    breaker: new ConsecutiveBreaker(3),
  });

  constructor(config: RedisConfig, source: string = "judge") {
    const useTls = config.redisPassword && config.redisPort !== 6379;
    this.redis = new Redis({
      host: config.redisHost,
      port: config.redisPort,
      password: config.redisPassword || undefined,
      ...(useTls ? { tls: { rejectUnauthorized: false } } : {}),
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 3) return null;
        return Math.min(times * 1000, 3000);
      },
    });
    this.source = source;

    this.redis.on("error", (err: Error) => {
      if (this.redisBreaker.state === CircuitState.Closed) {
        console.error("Redis connection error:", err.message);
      }
    });

    this.redisBreaker.onStateChange((state) => {
      if (state === CircuitState.Open) {
        console.error("Redis circuit breaker OPEN - stopping publish attempts for 1 minute");
      } else if (state === CircuitState.HalfOpen) {
        console.log("Redis circuit breaker HALF-OPEN - testing connection");
      } else if (state === CircuitState.Closed) {
        console.log("Redis circuit breaker CLOSED - connection restored");
      }
    });
  }

  async publish(
    requestId: string,
    level: LogEvent["level"],
    message: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    const logEvent: LogEvent = {
      timestamp: new Date().toISOString(),
      level,
      source: this.source,
      message,
      data,
    };

    const channel = `logs:${requestId}`;
    try {
      await this.redisBreaker.execute(() =>
        this.redis.publish(channel, JSON.stringify(logEvent))
      );
    } catch {
      // Silently ignore - circuit breaker handles logging state changes
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
