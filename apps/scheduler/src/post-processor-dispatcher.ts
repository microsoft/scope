// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection, Db } from "mongodb";
import { QueueClient } from "@azure/storage-queue";
import type { RequestDocument } from "@scope/core";

/**
 * PostProcessorDispatcher — detects completed runs needing post-processing
 * and enqueues them to the post-processor queue.
 *
 * This single mechanism handles both:
 * - Real-time: newly completed runs (postProcessorVersion missing)
 * - Backfill: old runs when post-processor version advances
 *
 * Only targets `request.run` (the latest run per request), never history runs.
 * Uses the same atomic claim pattern as RequestScheduler to prevent duplicates.
 */
export class PostProcessorDispatcher {
  private interval: ReturnType<typeof setInterval> | null = null;
  private dispatching = false;

  constructor(
    private readonly collection: Collection<RequestDocument>,
    private readonly db: Db,
    private readonly queueClient: QueueClient,
    private readonly pollIntervalMs: number = 30_000,
    private readonly batchSize: number = 30,
  ) {}

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.dispatch(), this.pollIntervalMs);
    void this.dispatch();
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    const deadline = Date.now() + 5_000;
    while (this.dispatching && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const targetVersion = await this.getTargetVersion();
      if (targetVersion <= 0) return; // No version registered yet

      for (let i = 0; i < this.batchSize; i++) {
        const claimed = await this.collection.findOneAndUpdate(
          {
            "run.status": "done",
            "run.postProcessorStatus": { $nin: ["queued", "processing"] },
            $or: [
              { "run.postProcessorVersion": { $exists: false } },
              { "run.postProcessorVersion": { $lt: targetVersion } },
            ],
            deletedAt: { $exists: false },
          } as any,
          {
            $set: { "run.postProcessorStatus": "queued" },
          } as any,
          {
            sort: { updatedAt: -1 },
            returnDocument: "after",
          },
        );

        if (!claimed) break;

        const message = Buffer.from(
          JSON.stringify({
            type: "atif",
            requestId: claimed._id,
            runId: (claimed as any).run?._id,
          }),
        ).toString("base64");

        try {
          await this.queueClient.sendMessage(message);
        } catch (err) {
          // Roll back status so the doc is picked up on next poll cycle
          await this.collection.updateOne(
            { _id: claimed._id } as any,
            { $unset: { "run.postProcessorStatus": "" } } as any,
          );
          console.error(`[PostProcessorDispatcher] Queue send failed for ${claimed._id}, rolled back status:`, err);
          break; // Stop batch — queue may be unavailable
        }
        console.log(`[PostProcessorDispatcher] Dispatched ${claimed._id}`);
      }
    } catch (err) {
      console.error("[PostProcessorDispatcher] Error during dispatch:", err);
    } finally {
      this.dispatching = false;
    }
  }

  /**
   * Reads the target post-processor version from the `services` collection.
   * Returns 0 if no version is registered (post-processor not yet deployed).
   */
  private async getTargetVersion(): Promise<number> {
    const doc = await this.db
      .collection("services")
      .findOne({ _id: "post-processor" } as any);
    return (doc as any)?.version ?? 0;
  }
}
