// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import type { ExperimentRequestState } from "./types.js";

const REQUEST_BUCKET_HASH_PREFIX = "experiment-request-bucket:v1\0";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function assignExperimentRequestBucket(
  requestId: string,
  bucketCount: number,
): number {
  if (!Number.isSafeInteger(bucketCount) || bucketCount <= 0) {
    throw new Error("bucketCount must be a positive safe integer");
  }
  const digest = sha256(`${REQUEST_BUCKET_HASH_PREFIX}${requestId}`);
  let unsignedBigEndian = 0n;
  for (const byte of digest) {
    unsignedBigEndian = (unsignedBigEndian << 8n) + BigInt(byte);
  }
  return Number(unsignedBigEndian % BigInt(bucketCount));
}

export function computeExperimentChunkId(input: {
  projectId: string;
  experimentId: string;
  kind: string;
  ownerId: string;
  generation: number;
  chunkIndex: number;
}): string {
  const canonical = JSON.stringify([
    "sha256-v1",
    input.projectId,
    input.experimentId,
    input.kind,
    input.ownerId,
    input.generation,
    input.chunkIndex,
  ]);
  return `ec_v1_${sha256(canonical).toString("base64url")}`;
}

export function fingerprintExperimentPayload(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("base64url");
}

export function fingerprintExperimentRequestVector(
  requests: readonly Pick<ExperimentRequestState, "requestId" | "runId">[],
): string {
  return fingerprintExperimentPayload(
    requests.map(({ requestId, runId }) => ({ requestId, runId })),
  );
}
