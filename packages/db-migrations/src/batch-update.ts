// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Shared batching utility for CosmosDB-safe bulk updates.
 *
 * CosmosDB (MongoDB API) returns error code 16500 when request-unit (RU)
 * throughput is exceeded. This helper:
 *   1. Collects matching _id values via a lightweight cursor (projection).
 *   2. Processes them in small batches with configurable pacing delay.
 *   3. Retries individual batches on 429 using the server-suggested RetryAfterMs.
 */

import type { Collection, ObjectId } from "mongodb";

export const BATCH_SIZE = 10;
export const INTER_BATCH_DELAY_MS = 500;

/** Sleep helper for retry backoff. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract RetryAfterMs from a CosmosDB error (may be a property or in the message string). */
export function getRetryAfterMs(err: any): number {
  if (typeof err?.retryAfterMs === "number") return err.retryAfterMs;
  const match = String(err?.message ?? "").match(/RetryAfterMs=(\d+)/);
  if (match) return parseInt(match[1], 10);
  return 2000;
}

/**
 * Update documents matching `filter` in batches, applying `update` to each batch.
 * Retries on CosmosDB 429 (error code 16500) with the server-suggested delay.
 */
export async function batchUpdate(
  col: Collection,
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
  label: string,
): Promise<number> {
  let total = 0;
  const ids: ObjectId[] = [];

  // Collect matching _id values first (lightweight projection)
  const cursor = col.find(filter, { projection: { _id: 1 } });
  for await (const doc of cursor) {
    ids.push(doc._id);
  }

  if (ids.length === 0) {
    console.log(`  ${label}: 0 documents`);
    return 0;
  }

  console.log(`  ${label}: ${ids.length} documents to process in ${Math.ceil(ids.length / BATCH_SIZE)} batches`);

  // Process in batches
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    let retries = 0;
    const maxRetries = 10;

    // Pace batches to avoid saturating RUs
    if (i > 0) {
      await sleep(INTER_BATCH_DELAY_MS);
    }

    while (retries < maxRetries) {
      try {
        const result = await col.updateMany({ _id: { $in: batch } }, update);
        total += result.modifiedCount;
        break;
      } catch (err: any) {
        // CosmosDB 429: error code 16500
        if (err?.code === 16500 && retries < maxRetries - 1) {
          const delay = Math.max(getRetryAfterMs(err), 500);
          console.log(`  ${label}: 429 on batch ${Math.floor(i / BATCH_SIZE) + 1}, retry ${retries + 1}/${maxRetries - 1}, waiting ${delay}ms...`);
          await sleep(delay);
          retries++;
        } else {
          throw err;
        }
      }
    }
  }

  console.log(`  ${label}: ${total} documents updated`);
  return total;
}

/**
 * Run a single `updateOne`, retrying on CosmosDB 429 (error code 16500) with
 * the server-suggested delay. For per-document migrations whose update value
 * differs per document (so `batchUpdate`'s shared update cannot be used).
 *
 * @param col - Collection to update.
 * @param filter - Selects the one document to update.
 * @param update - Update document (`$set` / `$unset` …).
 * @param label - Log label for retry messages.
 * @param maxRetries - Attempts before giving up (default 10).
 */
export async function updateOneWithRetry(
  col: Collection,
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
  label: string,
  maxRetries = 10,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await col.updateOne(filter, update);
      return;
    } catch (err: any) {
      if (err?.code !== 16500 || attempt >= maxRetries) throw err;

      const delay = Math.max(getRetryAfterMs(err), 500);
      console.log(`  ${label}: 429, retry ${attempt}/${maxRetries - 1}, waiting ${delay}ms...`);
      await sleep(delay);
    }
  }
}
