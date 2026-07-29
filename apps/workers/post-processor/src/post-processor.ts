// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { DequeuedMessageItem } from "@azure/storage-queue";
import { BaseQueueProcessor, type VisibilityHeartbeat } from "@scope/worker-runtime";
import { BlobStorage } from "@scope/platform";
import { Retry, type BaseQueueProcessorConfig, type LogEvent } from "@scope/core";
import { POST_PROCESSOR_VERSION } from "./version.js";
import type { PostProcessHandler, PostProcessorMessage, HandlerContext } from "./types.js";

export interface PostProcessorConfig extends BaseQueueProcessorConfig {
  apiBaseUrl?: string;
}

interface RequestDocument {
  _id: string;
  run?: {
    _id: string;
    status: string;
    turns?: Array<{ iteration: number; harUrl?: string; atifUrl?: string }>;
    postProcessorVersion?: number;
    postProcessorStatus?: string;
  };
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

  protected async handleRequest(
    doc: RequestDocument,
    message: DequeuedMessageItem,
    heartbeat: VisibilityHeartbeat,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const msg = payload as unknown as PostProcessorMessage;

    if (!msg?.type) {
      await log("warn", "Message missing 'type' field, discarding");
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    const handler = this.handlers.get(msg.type);
    if (!handler) {
      await log("warn", `No handler registered for type '${msg.type}', discarding`);
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    // Set status to "processing".
    // Concurrency safety: the Azure Storage Queue guarantees at-most-once delivery
    // via visibility timeout, so only one worker processes a given message at a time.
    await this.collection.updateOne(
      { _id: doc._id } as any,
      { $set: { "run.postProcessorStatus": "processing" } } as any,
    );

    try {
      await log("info", `Running handler: ${msg.type}`);

      const ctx: HandlerContext = {
        blobStorage: this.blobStorage,
        collection: this.collection as any,
        log,
      };

      await handler.process(msg, ctx);

      // Stamp version and status on success
      await this.collection.updateOne(
        { _id: doc._id } as any,
        {
          $set: {
            "run.postProcessorVersion": POST_PROCESSOR_VERSION,
            "run.postProcessorStatus": "done",
          },
        } as any,
      );

      await log("info", `Post-processing complete (v${POST_PROCESSOR_VERSION})`);

      // Trigger report generation now that enrichment is done (best-effort)
      try {
        await this.triggerReportGeneration(doc._id, log);
      } catch (error) {
        await log("warn", `Failed to trigger report generation after retries: ${error}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await log("error", `Handler '${msg.type}' failed: ${errMsg}`);

      // Mark as failed so scheduler doesn't immediately re-dispatch
      await this.collection.updateOne(
        { _id: doc._id } as any,
        { $set: { "run.postProcessorStatus": "failed" } } as any,
      );

      throw err;
    }

    // Delete queue message on success
    const popReceipt = heartbeat.stop();
    await this.safeDeleteMessage(message.messageId, popReceipt);
  }

  /**
   * Trigger report generation via REST API.
   * Called after post-processing succeeds so reports can use enriched data.
   */
  @Retry({ maxRetries: 3, baseDelayMs: 1000, isRetryable: () => true })
  private async triggerReportGeneration(requestId: string, log: (level: LogEvent["level"], message: string) => Promise<void>): Promise<void> {
    if (!this.apiBaseUrl) return;

    const response = await fetch(`${this.apiBaseUrl}/api/v1/reports/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId }),
    });
    if (response.ok) {
      const result = await response.json() as { triggered: number };
      await log("info", `Triggered report generation: ${result.triggered} report(s) created`);
      return;
    }
    if (response.status >= 400 && response.status < 500) {
      await log("warn", `Failed to trigger report generation (${response.status}), not retrying`);
      return;
    }
    throw new Error(`Report trigger returned ${response.status} ${response.statusText}`);
  }
}
