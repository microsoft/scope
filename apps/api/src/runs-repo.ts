// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Runs repository — thin DAL helpers around the `runs` collection.
 *
 * The `runs` collection stores **historical** attempts: every previous
 * RunState that was demoted from `RequestDocument.run` when a retry started
 * a new attempt. The current (live) attempt always lives inline on the
 * request document at `request.run`.
 *
 * Lookup model:
 *   - Latest attempt:  `request.run` (inline; not in the runs collection)
 *   - Older attempts:  `runs` collection, filtered by `requestId`
 *
 * Naming: this file is named `runs-repo.ts` (not `runs-history-repo.ts`)
 * because conceptually it owns *all* runs storage, including the future
 * possibility of moving the latest attempt into the collection too.
 *
 * See: growth-ecosystems/scope-core#658
 */

import type { Collection } from "mongodb";
import type { RunState, RunHistoryDocument } from "@scope/core";

export interface RunsRepoOptions {
  runsCollection: Collection<RunHistoryDocument>;
}

/**
 * Insert a run into the history collection. Used when a retry demotes the
 * previous `request.run` into the historical record.
 *
 * The historical document keeps the RunState `_id` (so artifact paths
 * remain valid) and gains a `requestId` back-reference.
 */
export async function insertHistoricalRun(
  opts: RunsRepoOptions,
  requestId: string,
  run: RunState,
): Promise<void> {
  const doc: RunHistoryDocument = { ...run, requestId };
  await opts.runsCollection.insertOne(doc as any);
}

/**
 * List historical attempts for a request, newest first.
 *
 * Note: this does NOT include the current/live attempt that lives inline
 * on the request document. Callers that want the full history should
 * concatenate `request.run` with this list (handling the case where the
 * request was just retried and `run` is the new attempt).
 */
export async function listHistoricalRuns(
  opts: RunsRepoOptions,
  requestId: string,
): Promise<RunHistoryDocument[]> {
  return opts.runsCollection
    .find({ requestId })
    .sort({ attemptNumber: -1 })
    .toArray();
}

/**
 * Fetch a single historical attempt by run id.
 *
 * Returns null if the id is not in the history collection — callers
 * should fall back to checking `request.run._id` for the current attempt.
 */
export async function getHistoricalRun(
  opts: RunsRepoOptions,
  runId: string,
): Promise<RunHistoryDocument | null> {
  return opts.runsCollection.findOne({ _id: runId } as any);
}
