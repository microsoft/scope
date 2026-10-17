// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { BSON } from "mongodb";
import { assignExperimentRequestBucket } from "./routing.js";
import type { ExperimentRequestState } from "./types.js";

export const EXPERIMENT_STORAGE_PROFILE = Object.freeze({
  maxDocumentBytes: 2 * 1024 * 1024,
  targetDocumentBytes: 256 * 1024,
  maxRequestEntryBytes: 4 * 1024,
  metadataReserveBytes: (256 * 1024) / 16,
  loadFactor: 0.8,
  maxBucketSearch: 65_536,
});

export interface FixedPayloadLayout {
  storage: "inline" | "chunked";
  bucketCount: number;
  buckets: ExperimentRequestState[][];
  bsonBytes: number[];
}

export function bsonSize(value: object): number {
  return BSON.calculateObjectSize(value);
}

export function experimentPayloadBudgetBytes(): number {
  return Math.floor(
    (EXPERIMENT_STORAGE_PROFILE.targetDocumentBytes -
      EXPERIMENT_STORAGE_PROFILE.metadataReserveBytes) *
      EXPERIMENT_STORAGE_PROFILE.loadFactor,
  );
}

export function assertExperimentRequestEntryBudget(
  entry: ExperimentRequestState,
): void {
  const bytes = bsonSize({
    position: Number.MAX_SAFE_INTEGER,
    state: entry,
  });
  if (bytes > EXPERIMENT_STORAGE_PROFILE.maxRequestEntryBytes) {
    throw new Error(
      `Experiment request ${entry.requestId} is ${bytes} bytes; maximum is ${EXPERIMENT_STORAGE_PROFILE.maxRequestEntryBytes}`,
    );
  }
}

export function selectFixedPayloadLayout(input: {
  entries: readonly ExperimentRequestState[];
  inlineDocument: (entries: ExperimentRequestState[]) => object;
  chunkDocument: (
    chunkIndex: number,
    bucketCount: number,
    entries: ExperimentRequestState[],
  ) => object;
}): FixedPayloadLayout {
  const entries = input.entries.map((entry) => structuredClone(entry));
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.requestId)) {
      throw new Error(`Duplicate experiment requestId '${entry.requestId}'`);
    }
    ids.add(entry.requestId);
    assertExperimentRequestEntryBudget(entry);
  }

  const inlineBytes = bsonSize(input.inlineDocument(entries));
  if (
    inlineBytes <= EXPERIMENT_STORAGE_PROFILE.targetDocumentBytes &&
    inlineBytes <= EXPERIMENT_STORAGE_PROFILE.maxDocumentBytes
  ) {
    return {
      storage: "inline",
      bucketCount: 0,
      buckets: [entries],
      bsonBytes: [inlineBytes],
    };
  }
  if (entries.length === 0) {
    throw new Error("An empty fixed payload must be stored inline");
  }

  const budget = experimentPayloadBudgetBytes();
  const maxEntriesPerBucket = Math.max(
    1,
    Math.floor(
      budget / EXPERIMENT_STORAGE_PROFILE.maxRequestEntryBytes,
    ),
  );
  const firstBucketCount = Math.ceil(entries.length / maxEntriesPerBucket);
  const lastBucketCount = Math.min(
    entries.length,
    EXPERIMENT_STORAGE_PROFILE.maxBucketSearch,
  );

  for (
    let bucketCount = firstBucketCount;
    bucketCount <= lastBucketCount;
    bucketCount += 1
  ) {
    const buckets = Array.from(
      { length: bucketCount },
      () => [] as ExperimentRequestState[],
    );
    for (const entry of entries) {
      buckets[
        assignExperimentRequestBucket(entry.requestId, bucketCount)
      ]!.push(entry);
    }
    const bsonBytes = buckets.map((bucket, chunkIndex) =>
      bsonSize(input.chunkDocument(chunkIndex, bucketCount, bucket)),
    );
    if (
      buckets.every((bucket) => bucket.length <= maxEntriesPerBucket) &&
      bsonBytes.every(
        (bytes) =>
          bytes <= budget &&
          bytes <= EXPERIMENT_STORAGE_PROFILE.maxDocumentBytes,
      )
    ) {
      return { storage: "chunked", bucketCount, buckets, bsonBytes };
    }
  }
  throw new Error(
    `No safe experiment request layout found within ${EXPERIMENT_STORAGE_PROFILE.maxBucketSearch} buckets`,
  );
}
