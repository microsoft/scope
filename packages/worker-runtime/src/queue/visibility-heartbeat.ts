// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { QueueClient } from "@azure/storage-queue";

/** How often to extend message visibility (ms). */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** Each heartbeat extends visibility by this many seconds.
 *  Set to 4× the interval so up to 3 consecutive tick failures can occur
 *  before the message reappears for another worker. */
export const HEARTBEAT_VISIBILITY_SECONDS = 60;

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
 * Optional callback invoked on every successful heartbeat tick. Used by the
 * queue processor to also bump a per-run liveness timestamp in MongoDB so
 * the redelivery handler can tell a real worker crash apart from a spurious
 * Azure Storage Queue redelivery while the original worker is still alive.
 *
 * The callback is awaited but its errors are caught and logged — a Mongo
 * write failure must never abort the visibility extension itself.
 */
export type HeartbeatTickCallback = (tickInfo: { tickCount: number }) => Promise<void> | void;

/**
 * Start a background loop that periodically extends a queue message's
 * visibility timeout via `QueueClient.updateMessage`. This keeps the message
 * hidden from other workers as long as this process is alive. If the worker
 * crashes, the heartbeat dies and the message reappears after at most
 * {@link HEARTBEAT_VISIBILITY_SECONDS} (default 30 s) instead of the
 * previous 35-minute single-shot extension.
 *
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
): VisibilityHeartbeat {
  let popReceipt = initialPopReceipt;
  let tickCount = 0;
  let failureCount = 0;
  const abort = new AbortController();
  const startedAt = Date.now();

  // Build a stable `key=value` suffix so log lines are easy to grep / parse.
  // Always includes messageId; documentId and runId are added when known.
  const ctxParts = [`messageId=${messageId}`];
  if (context.documentId) ctxParts.push(`documentId=${context.documentId}`);
  if (context.runId) ctxParts.push(`runId=${context.runId}`);
  const ctx = ctxParts.join(" ");

  console.log(
    `[${workerName}] Visibility heartbeat started (every ${intervalMs / 1000}s, extending by ${visibilityTimeoutSeconds}s) ${ctx}`,
  );

  const loop = async () => {
    while (!abort.signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        abort.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (abort.signal.aborted) break;
      try {
        const response = await queueClient.updateMessage(
          messageId, popReceipt, undefined, visibilityTimeoutSeconds,
        );
        popReceipt = response.popReceipt!;
        tickCount++;
        failureCount = 0;
        console.log(
          `[${workerName}] Visibility heartbeat tick #${tickCount} extended by ${visibilityTimeoutSeconds}s ${ctx}`,
        );
        if (onTick) {
          try {
            await onTick({ tickCount });
          } catch (cbError) {
            // Never let a callback failure abort the heartbeat loop — the
            // queue visibility extension already succeeded.
            console.warn(
              `[${workerName}] Visibility heartbeat onTick callback failed ${ctx}:`,
              cbError,
            );
          }
        }
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
      const elapsedMs = Date.now() - startedAt;
      console.log(
        `[${workerName}] Visibility heartbeat stopped after ${tickCount} tick(s), ${failureCount} consecutive failure(s), elapsed=${(elapsedMs / 1000).toFixed(1)}s ${ctx}`,
      );
      return popReceipt;
    },
    get popReceipt() { return popReceipt; },
  };
}
