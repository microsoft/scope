// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from "mongodb";
import { QueueClient } from "@azure/storage-queue";
import type { RequestDocument } from "@scope/core";

/**
 * Configuration for a single worker type's queue.
 */
export interface WorkerTypeConfig {
  /** The worker type identifier (e.g. "coder-acp-copilot") */
  workerType: string;
  /** Azure Storage Queue client for this worker type */
  queueClient: QueueClient;
  /** Maximum number of messages to keep in the queue at any time */
  targetQueueDepth: number;
}

/**
 * RequestScheduler — dispatches pending requests to Azure Storage Queues
 * in priority order while keeping the queue shallow.
 *
 * The scheduler polls MongoDB for requests with `run.status === "pending"`,
 * atomically claims them via `findOneAndUpdate` (setting `run.status` to
 * `"queued"`), and sends a `{ requestId, runId }` message to the
 * appropriate Azure Storage Queue.
 *
 * Queue depth is capped at `targetQueueDepth` per worker type using the
 * cheap `getProperties().approximateMessagesCount` metadata call. This
 * ensures priority changes and pauses take effect quickly — work sits in
 * MongoDB where we have full control, not in the FIFO queue.
 */
export class RequestScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private dispatching = false;

  constructor(
    private readonly collection: Collection<RequestDocument>,
    private readonly workerTypes: WorkerTypeConfig[],
    private readonly pollIntervalMs: number = 2000,
  ) {}

  /**
   * Start the dispatch loop. Safe to call multiple times (no-op if running).
   */
  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.dispatch(), this.pollIntervalMs);
    // Fire immediately on start rather than waiting for first interval
    void this.dispatch();
  }

  /**
   * Stop the dispatch loop and wait for any in-flight dispatch to finish.
   */
  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    // Wait for in-flight dispatch to complete (up to 5s)
    const deadline = Date.now() + 5_000;
    while (this.dispatching && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Run one dispatch cycle across all worker types.
   * Serialized: if a previous dispatch is still running, skip this tick.
   */
  private async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      for (const wt of this.workerTypes) {
        try {
          await this.dispatchForWorkerType(wt);
        } catch (err) {
          console.error(`[Scheduler] Error dispatching for ${wt.workerType}:`, err);
        }
      }
    } finally {
      this.dispatching = false;
    }
  }

  /**
   * Fill available queue slots for a single worker type by claiming
   * the highest-priority pending requests from MongoDB.
   */
  private async dispatchForWorkerType(wt: WorkerTypeConfig): Promise<void> {
    // Read the actual Azure queue depth — cheap metadata call, not a message read
    const properties = await wt.queueClient.getProperties();
    const currentDepth = properties.approximateMessagesCount ?? 0;

    const slots = wt.targetQueueDepth - currentDepth;
    if (slots <= 0) return;

    for (let i = 0; i < slots; i++) {
      const claimed = await this.collection.findOneAndUpdate(
        {
          "run.status": "pending",
          workerType: wt.workerType,
          deletedAt: { $exists: false },
        } as any,
        {
          $set: {
            "run.status": "queued",
            "run.updatedAt": new Date(),
          },
        } as any,
        {
          sort: { priority: -1, createdAt: 1 },
          returnDocument: "after",
        },
      );

      if (!claimed) break;

      console.log(`[Scheduler] ${wt.workerType}: dispatched ${claimed._id} (priority=${claimed.priority}, depth=${currentDepth + i + 1}/${wt.targetQueueDepth})`);

      // Queue message carries requestId + runId (per PR #665 convention)
      const message = Buffer.from(
        JSON.stringify({
          requestId: claimed._id,
          runId: claimed.run?._id,
        }),
      ).toString("base64");

      await wt.queueClient.sendMessage(message);
    }
  }
}
