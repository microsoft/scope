// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Move `workerVersion` into the `worker` sub-document (issue #855).
 *
 * Worker identity on a run attempt used to be split across two fields:
 * `run.worker = { instanceId, podName? }` (added in #846) and the older
 * `run.workerVersion`. They are now one sub-document, `run.worker.version`.
 *
 *   - `requests`: `run.workerVersion` → `run.worker.version`
 *   - `runs` (RunHistoryDocument): `workerVersion` → `worker.version`
 *
 * The legacy field is unset afterwards. An existing `worker.version` is never
 * overwritten. Runs picked up before #846 have no `worker` sub-document, so
 * they end up with a version-only `worker` (no `instanceId`); worker-ownership
 * filters treat a missing `instanceId` as "no owner".
 *
 * Values are copied per document with plain `$set` / `$unset` (no update
 * pipelines) to stay compatible with the CosmosDB MongoDB API.
 *
 * down() reverses the move for documents that have `worker.version`, and
 * removes `worker` entirely when the version was its only field.
 */

import type { Collection, Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { INTER_BATCH_DELAY_MS, sleep, updateOneWithRetry } from "../batch-update.js";

const TAG = "031";

/** Shape of the projected worker fields read from a run-state object. */
interface RunWorkerFields {
  workerVersion?: unknown;
  worker?: { instanceId?: unknown; podName?: unknown; version?: unknown } | null;
}

/** A `$set` / `$unset` pair for one document; either side may be empty. */
export interface FieldMoveUpdate {
  $set: Record<string, unknown>;
  $unset: Record<string, "">;
}

/**
 * Build the update that moves `workerVersion` into `worker.version`.
 *
 * @param state - The run-state object (`doc.run` for requests, `doc` for runs).
 * @param prefix - Dot-path prefix of the run state: `"run."` or `""`.
 * @returns The update, or `null` when there is no legacy field to move.
 */
export function buildWorkerVersionMoveUpdate(
  state: RunWorkerFields | undefined,
  prefix: string,
): FieldMoveUpdate | null {
  if (!state || state.workerVersion === undefined) return null;

  const update: FieldMoveUpdate = { $set: {}, $unset: { [`${prefix}workerVersion`]: "" } };

  // Never clobber a version already recorded in the new location.
  const hasNewVersion = typeof state.worker?.version === "string";
  if (typeof state.workerVersion === "string" && !hasNewVersion) {
    update.$set[`${prefix}worker.version`] = state.workerVersion;
  }

  return update;
}

/**
 * Build the update that moves `worker.version` back to `workerVersion`.
 *
 * @param state - The run-state object (`doc.run` for requests, `doc` for runs).
 * @param prefix - Dot-path prefix of the run state: `"run."` or `""`.
 * @returns The update, or `null` when there is no `worker.version` to move.
 */
export function buildWorkerVersionRevertUpdate(
  state: RunWorkerFields | undefined,
  prefix: string,
): FieldMoveUpdate | null {
  const version = state?.worker?.version;
  if (typeof version !== "string") return null;

  // A version-only worker sub-document was created by up(); drop it whole.
  const onlyVersion = state?.worker?.instanceId === undefined && state?.worker?.podName === undefined;

  return {
    $set: { [`${prefix}workerVersion`]: version },
    $unset: onlyVersion ? { [`${prefix}worker`]: "" } : { [`${prefix}worker.version`]: "" },
  };
}

/** Strip empty `$set` / `$unset` operators, which MongoDB rejects. */
function toMongoUpdate(update: FieldMoveUpdate): Record<string, unknown> {
  return {
    ...(Object.keys(update.$set).length > 0 ? { $set: update.$set } : {}),
    ...(Object.keys(update.$unset).length > 0 ? { $unset: update.$unset } : {}),
  };
}

/**
 * Apply `buildUpdate` to every document in `col` matching `filter`, one paced
 * write per document.
 *
 * @param col - Collection to update.
 * @param filter - Selects candidate documents.
 * @param projection - Fields needed by `buildUpdate`.
 * @param pickState - Returns the run-state object of a document.
 * @param buildUpdate - Builds the per-document update (or `null` to skip).
 * @param label - Log label.
 * @returns Number of documents updated.
 */
async function moveFields(
  col: Collection,
  filter: Record<string, unknown>,
  projection: Record<string, 1>,
  pickState: (doc: Record<string, any>) => RunWorkerFields | undefined,
  buildUpdate: (state: RunWorkerFields | undefined) => FieldMoveUpdate | null,
  label: string,
): Promise<number> {
  let updated = 0;

  for await (const doc of col.find(filter, { projection })) {
    const update = buildUpdate(pickState(doc));
    if (!update) continue;

    // Pace writes so a large backfill doesn't saturate CosmosDB RUs.
    if (updated > 0) await sleep(INTER_BATCH_DELAY_MS);

    await updateOneWithRetry(col, { _id: doc._id }, toMongoUpdate(update), label);
    updated++;
  }

  console.log(`  ${label}: ${updated} documents updated`);
  return updated;
}

export class MoveWorkerVersion implements MigrationInterface {
  async up(db: Db): Promise<void> {
    await moveFields(
      db.collection("requests"),
      { "run.workerVersion": { $exists: true } },
      { _id: 1, "run.workerVersion": 1, "run.worker": 1 },
      (doc) => doc.run,
      (state) => buildWorkerVersionMoveUpdate(state, "run."),
      `[${TAG}] requests run.workerVersion → run.worker.version`,
    );

    await moveFields(
      db.collection("runs"),
      { workerVersion: { $exists: true } },
      { _id: 1, workerVersion: 1, worker: 1 },
      (doc) => doc,
      (state) => buildWorkerVersionMoveUpdate(state, ""),
      `[${TAG}] runs workerVersion → worker.version`,
    );
  }

  async down(db: Db): Promise<void> {
    await moveFields(
      db.collection("requests"),
      { "run.worker.version": { $exists: true } },
      { _id: 1, "run.worker": 1 },
      (doc) => doc.run,
      (state) => buildWorkerVersionRevertUpdate(state, "run."),
      `[${TAG}-down] requests run.worker.version → run.workerVersion`,
    );

    await moveFields(
      db.collection("runs"),
      { "worker.version": { $exists: true } },
      { _id: 1, worker: 1 },
      (doc) => doc,
      (state) => buildWorkerVersionRevertUpdate(state, ""),
      `[${TAG}-down] runs worker.version → workerVersion`,
    );
  }
}
