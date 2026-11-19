// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { QueueClient } from "@azure/storage-queue";

/** How often to extend message visibility (ms). */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** Each heartbeat extends visibility by this many seconds.
 *  Set to 4× the interval so up to 3 consecutive tick failures can occur
 *  before the message reappears for another worker. */
export const HEARTBEAT_VISIBILITY_SECONDS = 60;
/** Client-side deadline for a single `updateMessage` call (ms).
 *  The Azure SDK has no request timeout of its own, so a frozen queue
 *  endpoint would otherwise block the visibility loop forever without ever
 *  reporting a failed tick (issue #805). Kept below the interval so a hung
 *  request is reported before the next tick is due. */
export const HEARTBEAT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Error raised when a visibility extension does not settle within its
 * client-side deadline.
 */
export class HeartbeatRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Visibility heartbeat updateMessage timed out after ${timeoutMs}ms`);
    this.name = "HeartbeatRequestTimeoutError";
  }
}

/**
 * Extend a message's visibility with a client-side deadline.
 *
 * The request is cancelled through the SDK's `abortSignal` when either the
 * deadline elapses or the heartbeat is stopped. The call is also raced
 * against the deadline so the loop makes progress even if the transport
 * ignores the abort signal.
 *
 * @param queueClient - Queue holding the in-flight message.
 * @param messageId - Message whose visibility is extended.
 * @param popReceipt - Latest pop receipt for the message.
 * @param visibilityTimeoutSeconds - New server-side visibility window (seconds).
 * @param timeoutMs - Client-side deadline for the request (ms).
 * @param stopSignal - Aborted when the heartbeat stops; cancels the request.
 * @returns The new pop receipt.
 * @throws {HeartbeatRequestTimeoutError} When the deadline elapses first.
 */
async function updateMessageWithTimeout(
  queueClient: QueueClient,
  messageId: string,
  popReceipt: string,
  visibilityTimeoutSeconds: number,
  timeoutMs: number,
  stopSignal: AbortSignal,
): Promise<string> {
  const requestAbort = new AbortController();
  const abortRequest = () => requestAbort.abort();
  stopSignal.addEventListener("abort", abortRequest, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      requestAbort.abort();
      reject(new HeartbeatRequestTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      queueClient.updateMessage(messageId, popReceipt, undefined, visibilityTimeoutSeconds, {
        abortSignal: requestAbort.signal,
      }),
      deadline,
    ]);
    return response.popReceipt!;
  } finally {
    clearTimeout(timer);
    stopSignal.removeEventListener("abort", abortRequest);
  }
}

/**
 * Handle returned by {@link startVisibilityHeartbeat}.
 */
export interface VisibilityHeartbeat {
  /** Stop the heartbeat and return the latest pop receipt. Idempotent. */
  stop(): string;
  /** Current pop receipt (updated by each heartbeat tick). */
  readonly popReceipt: string;
}

/**
 * Optional correlation fields included in heartbeat log lines so you can
 * attribute them to a specific message / document / run when many workers
 * are running in parallel.
 */
export interface HeartbeatLogContext {
  documentId?: string;
  runId?: string;
}

/**
 * Optional callback invoked on every liveness tick. Used by the queue
 * processor to bump a per-run liveness timestamp in Redis so the redelivery
 * handler and the StuckRunReaper can tell a real worker crash apart from a
 * spurious redelivery while the original worker is still alive. Runs on a
 * dedicated interval (see {@link startVisibilityHeartbeat}); its errors are
 * caught and logged so a Redis write failure never aborts the loops.
 */
export type HeartbeatTickCallback = (tickInfo: { tickCount: number }) => Promise<void> | void;

/**
 * Start the heartbeat for an in-flight queue message. This drives two
 * INDEPENDENT loops so that a failure in one can never starve the other:
 *
 *   1. Visibility loop — periodically extends the queue message's visibility
 *      timeout via `QueueClient.updateMessage`, keeping the message hidden from
 *      other workers as long as this process is alive. If the worker crashes,
 *      the heartbeat dies and the message reappears after at most
 *      {@link HEARTBEAT_VISIBILITY_SECONDS} instead of the previous 35-minute
 *      single-shot extension.
 *
 *   2. Liveness loop — when `onTick` is provided, fires it on a DEDICATED
 *      `setInterval` to record per-run liveness (a Redis timestamp the reaper /
 *      redelivery handler read). This is deliberately decoupled from the
 *      visibility extension: a transient `updateMessage` failure under
 *      concurrent load (or a slow extension await) must NOT prevent the
 *      liveness write, otherwise a healthy, busy worker would be reaped as
 *      "stale heartbeat" (see issue #1064). Each loop tolerates the other
 *      failing.
 *
 * Each visibility extension has a client-side deadline
 * ({@link HEARTBEAT_REQUEST_TIMEOUT_MS} by default), so a frozen queue
 * endpoint surfaces as a failed tick instead of silently stalling the loop.
 *
 * @param requestTimeoutMs - Client-side deadline for each `updateMessage`
 *   call (ms). Defaults to {@link HEARTBEAT_REQUEST_TIMEOUT_MS}.
 * @returns A handle to stop the heartbeat and retrieve the latest pop receipt.
 */
export function startVisibilityHeartbeat(
  queueClient: QueueClient,
  messageId: string,
  initialPopReceipt: string,
  workerName: string,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
  visibilityTimeoutSeconds: number = HEARTBEAT_VISIBILITY_SECONDS,
  context: HeartbeatLogContext = {},
  onTick?: HeartbeatTickCallback,
  requestTimeoutMs: number = HEARTBEAT_REQUEST_TIMEOUT_MS,
): VisibilityHeartbeat {
  let popReceipt = initialPopReceipt;
  let tickCount = 0;
  let failureCount = 0;
  let livenessTickCount = 0;
  let livenessInFlight = false;
  const abort = new AbortController();
  const startedAt = Date.now();
  let livenessTimer: ReturnType<typeof setInterval> | undefined;

  // Build a stable `key=value` suffix so log lines are easy to grep / parse.
  // Always includes messageId; documentId and runId are added when known.
  const ctxParts = [`messageId=${messageId}`];
  if (context.documentId) ctxParts.push(`documentId=${context.documentId}`);
  if (context.runId) ctxParts.push(`runId=${context.runId}`);
  const ctx = ctxParts.join(" ");

  console.log(
    `[${workerName}] Visibility heartbeat started (every ${intervalMs / 1000}s, extending by ${visibilityTimeoutSeconds}s${onTick ? ", liveness on dedicated interval" : ""}) ${ctx}`,
  );

  // Loop 1 — queue visibility extension. Owns only the pop receipt; it no
  // longer drives the liveness write so a failed/slow updateMessage cannot
  // starve liveness.
  const loop = async () => {
    while (!abort.signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        abort.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (abort.signal.aborted) break;
      try {
        popReceipt = await updateMessageWithTimeout(
          queueClient, messageId, popReceipt, visibilityTimeoutSeconds, requestTimeoutMs, abort.signal,
        );
        tickCount++;
        failureCount = 0;
        console.log(
          `[${workerName}] Visibility heartbeat tick #${tickCount} extended by ${visibilityTimeoutSeconds}s ${ctx}`,
        );
      } catch (error) {
        if (abort.signal.aborted) break;
        failureCount++;
        console.warn(
          `[${workerName}] Visibility heartbeat tick failed (${failureCount} consecutive) ${ctx}:`,
          error,
        );
      }
    }
  };

  loop().catch(() => {}); // fire-and-forget

  // Loop 2 — per-run liveness. Independent timer so it keeps writing even when
  // the visibility extension is failing or its await is slow. A re-entrancy
  // guard prevents overlapping ticks if a single onTick runs long.
  if (onTick) {
    const runLiveness = async () => {
      if (abort.signal.aborted || livenessInFlight) return;
      livenessInFlight = true;
      const seq = livenessTickCount + 1;
      try {
        await onTick({ tickCount: seq });
        livenessTickCount = seq;
        console.log(
          `[${workerName}] Liveness heartbeat tick #${livenessTickCount} ${ctx}`,
        );
      } catch (cbError) {
        // Never let a callback failure abort the heartbeat — surface it so a
        // persistently-failing liveness write is visible in pod stdout.
        console.warn(
          `[${workerName}] Liveness heartbeat tick failed ${ctx}:`,
          cbError,
        );
      } finally {
        livenessInFlight = false;
      }
    };
    livenessTimer = setInterval(() => { void runLiveness(); }, intervalMs);
  }

  return {
    stop: () => {
      if (abort.signal.aborted) {
        // Idempotent: already stopped — return the frozen receipt without
        // re-logging. The base class always calls stop() in its finally
        // block as defensive cleanup, so subclass + base produce two calls
        // on the success path; we only want one log line.
        return popReceipt;
      }
      abort.abort();
      if (livenessTimer) {
        clearInterval(livenessTimer);
        livenessTimer = undefined;
      }
      const elapsedMs = Date.now() - startedAt;
      console.log(
        `[${workerName}] Visibility heartbeat stopped after ${tickCount} tick(s), ${failureCount} consecutive failure(s), ${livenessTickCount} liveness tick(s), elapsed=${(elapsedMs / 1000).toFixed(1)}s ${ctx}`,
      );
      return popReceipt;
    },
    get popReceipt() { return popReceipt; },
  };
}
