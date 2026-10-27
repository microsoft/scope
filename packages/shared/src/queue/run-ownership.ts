// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Run-ownership guard for mid-run writes (issue #803).
 *
 * A worker owns a run attempt from its atomic `queued → processing` claim
 * until the terminal write. Ownership can be lost while the worker is still
 * running — the run is cancelled, reaped as stuck, marked failed by a
 * redelivered message, or superseded by a retry (new `run._id`). Every
 * incremental write is therefore filtered on {@link ownedRunFilter}; when it
 * matches nothing, the worker is a zombie and must stop instead of writing
 * turns into a run (or attempt) it no longer owns.
 */

/**
 * Mongo filter that matches a request only while `instanceId` still owns the
 * processing attempt `runId`.
 *
 * @param requestId - Request document `_id`.
 * @param runId - The attempt's `run._id` this worker claimed.
 * @param instanceId - This worker process's `run.worker.instanceId`.
 */
export function ownedRunFilter(requestId: string, runId: string, instanceId: string): Record<string, unknown> {
  return {
    _id: requestId,
    "run._id": runId,
    "run.status": "processing",
    "run.worker.instanceId": instanceId,
  };
}

/**
 * Thrown when an ownership-filtered write matches no document: this worker no
 * longer owns the run. Propagates out of the multi-turn loop to stop further
 * agent/judge work; the base queue processor recognizes it and skips the
 * failure write (the new owner, or the cancel/reap, already set the state).
 */
export class RunOwnershipLostError extends Error {
  /**
   * @param requestId - Request document `_id`.
   * @param runId - The attempt this worker claimed.
   * @param operation - Short description of the write that detected the loss.
   */
  constructor(
    readonly requestId: string,
    readonly runId: string,
    readonly operation: string,
  ) {
    super(
      `Lost ownership of run ${runId} (request ${requestId}) while writing ${operation} — ` +
      `it was cancelled, reaped, failed by a redelivery, or retried; stopping this attempt`,
    );
    this.name = "RunOwnershipLostError";
  }
}
