// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { DequeuedMessageItem } from "@azure/storage-queue";
import { BaseQueueProcessor, BlobStorage, type BaseQueueProcessorConfig, type LogEvent, type VisibilityHeartbeat } from "shared";
import type { RequestDocument, HandlerRunStatus } from "shared";
import { trackMetric, trackEvent } from "telemetry";
import type { PostProcessHandler, PostProcessorMessage, HandlerContext } from "./types.js";

export interface PostProcessorConfig extends BaseQueueProcessorConfig {
  apiBaseUrl?: string;
}

/**
 * Post-processor worker: extensible queue processor with handler registry.
 * Dispatched by the PostProcessorDispatcher in the scheduler when runs
 * complete and need post-processing (or re-processing after version bump).
 */
export class PostProcessor extends BaseQueueProcessor<RequestDocument> {
  private handlers = new Map<string, PostProcessHandler>();
  private blobStorage: BlobStorage;
  private apiBaseUrl?: string;
  private static coldStartTracked = false;

  constructor(config: PostProcessorConfig) {
    super(config, "post-processor");
    this.apiBaseUrl = config.apiBaseUrl;
    this.blobStorage = new BlobStorage({
      storageAccountName: config.storageAccountName,
      storageConnectionString: config.storageConnectionString,
    });
  }

  registerHandler(handler: PostProcessHandler): void {
    this.handlers.set(handler.type, handler);
    console.log(`[post-processor] Registered handler: ${handler.type}`);
  }

  private isPostProcessorMessage(payload: unknown): payload is PostProcessorMessage {
    return typeof payload === "object" &&
      payload !== null &&
      typeof (payload as Record<string, unknown>).type === "string" &&
      typeof (payload as Record<string, unknown>).requestId === "string" &&
      typeof (payload as Record<string, unknown>).runId === "string";
  }

  private buildHandlerClaimFilter(
    requestId: string,
    runId: string,
    handlerId: string,
    handler: PostProcessHandler,
  ): Record<string, unknown> {
    // "queued" is deliberately NOT excluded: the scheduler writes a best-effort
    // "queued" marker immediately after enqueueing (enqueue-before-claim), so by
    // the time this message is dequeued the status is almost always "queued".
    // The worker is exactly what transitions queued -> processing, so it must be
    // able to claim a "queued" attempt. Excluding it would let the worker discard
    // its own message and strand the run at "queued" (the scheduler poll also
    // excludes "queued", so nothing would ever retry it). We only exclude
    // "processing" (another worker is mid-flight) and — for non-backfill handlers
    // — "done" (already complete). For autoBackfill, "done" is gated by the
    // version check below instead, so a version bump can re-process it.
    const statusExclusions = handler.autoBackfill
      ? ["processing"]
      : ["processing", "done"];

    const filter: Record<string, unknown> = {
      _id: requestId,
      "run._id": runId,
      "run.status": "done",
      [`run.handlerStatus.${handlerId}.status`]: { $nin: statusExclusions },
    };

    if (handler.autoBackfill) {
      filter.$or = [
        { [`run.handlerStatus.${handlerId}.version`]: { $exists: false } },
        { [`run.handlerStatus.${handlerId}.version`]: { $lt: handler.version } },
      ];
    } else {
      filter[`run.handlerStatus.${handlerId}.version`] = { $exists: false };
    }

    return filter;
  }

  protected async handleRequest(
    doc: RequestDocument,
    message: DequeuedMessageItem,
    heartbeat: VisibilityHeartbeat,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const processStart = Date.now();

    if (!PostProcessor.coldStartTracked) {
      PostProcessor.coldStartTracked = true;
      trackMetric({
        name: "post_processor.cold_start_ms",
        value: process.uptime() * 1000,
        properties: { service: "post-processor" },
      });
    }

    if (!this.isPostProcessorMessage(payload)) {
      await log("warn", "Message missing 'type' field, discarding");
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    const msg: PostProcessorMessage = payload;

    const handler = this.handlers.get(msg.type);
    if (!handler) {
      await log("warn", `No handler registered for type '${msg.type}', discarding`);
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    if (doc.run?._id !== msg.runId) {
      await log("info", "Stale post-processing message discarded (runId mismatch)", {
        messageRunId: msg.runId,
        currentRunId: doc.run?._id,
      });
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    const handlerId = `pp-${msg.type}`;
    const currentStatus = doc.run?.handlerStatus?.[handlerId] as HandlerRunStatus | undefined;

    // This is the authoritative claim. A queued message alone does not mean the
    // handler still needs work: the scheduler may have enqueued optimistically,
    // another worker may already be processing it, or a fresher backfill may
    // have completed it. Only the worker can safely decide that by atomically
    // transitioning the specific run attempt into "processing".
    const claim = await this.collection.findOneAndUpdate(
      this.buildHandlerClaimFilter(doc._id, msg.runId, handlerId, handler) as any,
      {
        $set: {
          "run.postProcessorStatus": "processing",
          [`run.handlerStatus.${handlerId}.status`]: "processing",
          [`run.handlerStatus.${handlerId}.updatedAt`]: new Date(),
        },
        $unset: {
          [`run.handlerStatus.${handlerId}.error`]: "",
        },
      } as any,
      { returnDocument: "after" },
    );

    if (!claim) {
      // No claim means the message is stale, duplicate, or already satisfied.
      // Ack and drop it — at-least-once delivery is expected here.
      await log("info", "Post-processing message no longer needed, discarding", {
        handlerId,
        runId: msg.runId,
        currentStatus: currentStatus?.status,
        currentVersion: currentStatus?.version,
        targetVersion: handler.version,
      });
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    try {
      await log("info", `Running handler: ${msg.type}`);
      trackEvent({
        name: "post_processor.processing_started",
        properties: { handlerType: msg.type, requestId: doc._id },
      });

      const ctx: HandlerContext = {
        blobStorage: this.blobStorage,
        collection: this.collection as any,
        log,
      };

      await handler.process(msg, ctx);

      // Stamp version and status on success (legacy fields + new handlerStatus)
      const successResult = await this.collection.updateOne(
        {
          _id: doc._id,
          "run._id": msg.runId,
          [`run.handlerStatus.${handlerId}.status`]: "processing",
        } as any,
        {
          $set: {
            "run.postProcessorVersion": handler.version,
            "run.postProcessorStatus": "done",
            [`run.handlerStatus.${handlerId}.status`]: "done",
            [`run.handlerStatus.${handlerId}.version`]: handler.version,
            [`run.handlerStatus.${handlerId}.updatedAt`]: new Date(),
          },
        } as any,
      );

      if ((successResult.matchedCount ?? 0) === 0) {
        await log("warn", `Handler '${msg.type}' completed after state changed; skipping terminal write`, {
          handlerId,
          runId: msg.runId,
        });
        await this.safeDeleteMessage(message.messageId, heartbeat.stop());
        return;
      }

      await log("info", `Post-processing complete (v${handler.version})`);
      trackMetric({
        name: "post_processor.processing_duration_ms",
        value: Date.now() - processStart,
        properties: { service: "post-processor", handlerType: msg.type },
      });
      trackEvent({
        name: "post_processor.processing_completed",
        properties: { handlerType: msg.type, requestId: doc._id },
      });

      // Notify the scheduler that this handler is done (best-effort)
      await this.notifyHandlerComplete(doc._id, doc.run?._id ?? "", handlerId, "done");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await log("error", `Handler '${msg.type}' failed: ${errMsg}`);

      // Mark as failed so scheduler doesn't immediately re-dispatch
      const failureResult = await this.collection.updateOne(
        {
          _id: doc._id,
          "run._id": msg.runId,
          [`run.handlerStatus.${handlerId}.status`]: "processing",
        } as any,
        {
          $set: {
            "run.postProcessorStatus": "failed",
            [`run.handlerStatus.${handlerId}.status`]: "failed",
            [`run.handlerStatus.${handlerId}.updatedAt`]: new Date(),
            [`run.handlerStatus.${handlerId}.error`]: errMsg,
          },
        } as any,
      );

      if ((failureResult.matchedCount ?? 0) > 0) {
        // Notify scheduler of failure (best-effort — don't dispatch downstream)
        await this.notifyHandlerComplete(doc._id, doc.run?._id ?? "", handlerId, "failed");
      }

      throw err;
    }

    // Delete queue message on success
    const popReceipt = heartbeat.stop();
    await this.safeDeleteMessage(message.messageId, popReceipt);
  }

  /**
   * Notify the scheduler that a handler completed (or failed).
   * Best-effort — the scheduler's poll safety net will catch up if this fails.
   */
  private async notifyHandlerComplete(
    requestId: string,
    runId: string,
    handlerId: string,
    status: "done" | "failed",
  ): Promise<void> {
    const schedulerUrl = process.env.SCHEDULER_URL;
    if (!schedulerUrl) return;

    try {
      const response = await fetch(`${schedulerUrl}/notify/handler-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, runId, handlerId, status }),
      });
      if (response.ok) {
        console.log(`[post-processor] Notified scheduler: ${handlerId} ${status} for ${requestId}`);
      } else {
        console.warn(`[post-processor] Scheduler notify failed: ${response.status}`);
      }
    } catch (err) {
      console.warn(`[post-processor] Scheduler notify error for ${handlerId}/${requestId}:`, err);
    }
  }
}
