// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Retry utility for transient failures (e.g. CosmosDB 429 TooManyRequests).
 *
 * Delegates to cockatiel for exponential backoff with jitter.
 * Adds CosmosDB-specific error detection.
 */

import {
  ExponentialBackoff,
  handleWhen,
  retry,
} from "cockatiel";

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 5) */
  maxRetries?: number;
  /** Base delay in ms before the first retry (default: 100) */
  baseDelayMs?: number;
  /** Maximum delay in ms between retries (default: 5000) */
  maxDelayMs?: number;
  /** Predicate to decide if an error is retryable. Defaults to isCosmosDb429. */
  isRetryable?: (error: unknown) => boolean;
  /** Called before each retry attempt. Useful for logging. */
  onRetry?: (error: unknown, attempt: number) => void;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 5_000;

/**
 * Returns true if the error is a CosmosDB 429 (TooManyRequests) or a
 * MongoDB driver wrapper around one.
 */
export function isCosmosDb429(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("TooManyRequests") || msg.includes("Request rate is large");
}

/**
 * Executes `fn` and retries on transient errors with exponential backoff + jitter.
 * Backed by cockatiel's retry policy.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const isRetryable = options?.isRetryable ?? isCosmosDb429;

  const policy = retry(handleWhen((err) => isRetryable(err)), {
    maxAttempts: maxRetries,
    backoff: new ExponentialBackoff({
      initialDelay: baseDelayMs,
      maxDelay: maxDelayMs,
    }),
  });

  policy.onRetry((evt) => {
    const error = 'error' in evt ? evt.error : undefined;
    if (options?.onRetry) {
      options.onRetry(error, evt.attempt);
    } else {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[withRetry] Attempt ${evt.attempt} failed, retrying: ${msg.substring(0, 200)}`);
    }
  });

  return policy.execute(() => fn());
}

/**
 * TC39 method decorator that wraps an async method with retry logic.
 *
 * Usage:
 *   @Retry({ maxRetries: 3, baseDelayMs: 1000, isRetryable: () => true })
 *   async myMethod() { ... }
 */
export function Retry(options?: RetryOptions) {
  return function <T extends (...args: any[]) => Promise<any>>(
    target: T,
    context: ClassMethodDecoratorContext,
  ): T {
    return function (this: any, ...args: any[]) {
      return withRetry(() => target.apply(this, args), options);
    } as unknown as T;
  };
}
