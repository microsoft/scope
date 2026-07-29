// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { MongoClient, Collection, Db } from "mongodb";
import { QueueClient, DequeuedMessageItem } from "@azure/storage-queue";
import { DefaultAzureCredential } from "@azure/identity";
import { randomUUID } from "node:crypto";
import { LogEvent, BaseQueueProcessorConfig } from "@scope/core";
import { LogPublisher } from "../logging/log-publisher.js";
import { BlobStorage } from "@scope/platform";
import { cancelExit } from "./cancel-exit.js";
import { withRetry } from "@scope/core";
import {
  startVisibilityHeartbeat,
  type VisibilityHeartbeat,
} from "./visibility-heartbeat.js";
import {
  RedisHeartbeatStore,
  type HeartbeatStore,
} from "./heartbeat-store.js";

/**
 * Generic queue processor that polls an Azure Storage Queue and processes messages.
 * Subclasses implement `handleRequest()` to define worker-specific behavior.
 *
 * Handles: MongoDB connection, queue polling, message decoding, log publishing,
 * error handling, and message lifecycle management.
 */
export abstract class BaseQueueProcessor<TDocument extends { _id: string } = any> {
  private mongoClient: MongoClient;
  protected db!: Db;
  protected collection!: Collection<TDocument>;
  protected queueClient: QueueClient;
  protected config: BaseQueueProcessorConfig;
  protected logPublisher!: LogPublisher;
  /** Per-run liveness heartbeat store (Redis-backed in production).
   *  Subclasses can override in tests via {@link setHeartbeatStore}. */
  protected heartbeatStore!: HeartbeatStore;
  protected workerName: string;
  /** Per-process UUID generated at construction time. Stamped on
   *  `run.worker.instanceId` when this worker picks up a message and used
   *  to gate heartbeat writes (so a stale worker can't keep heart-beating
   *  for a run another worker has taken over). */
  protected readonly instanceId: string = randomUUID();
  /** Kubernetes pod name (or whatever `process.env.HOSTNAME` is set to).
   *  Stamped on `run.worker.podName` for troubleshooting. Optional. */
  protected readonly podName: string | undefined = process.env.HOSTNAME || undefined;
  private stopping = false;
  private processing = false;

  constructor(config: BaseQueueProcessorConfig, workerName: string) {
    this.config = config;
    this.workerName = workerName;

    // MongoDB client
    this.mongoClient = new MongoClient(config.mongoUri);

    // Queue client - support both Azure and Azurite
    if (config.storageConnectionString) {
      // Connection string auth (local Azurite or Azure with connection string)
      this.queueClient = new QueueClient(
        config.storageConnectionString,
        config.queueName
      );
    } else {
      // Azure with DefaultAzureCredential
      const credential = new DefaultAzureCredential();
      const queueUrl = `https://${config.storageAccountName}.queue.core.windows.net`;
      this.queueClient = new QueueClient(`${queueUrl}/${config.queueName}`, credential);
    }

    // Register graceful shutdown handlers
    const shutdown = () => this.shutdown();
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }

  /**
   * Signal the worker to stop after finishing the current message.
   * Closes MongoDB and Redis connections, then exits.
   */
  private async shutdown(): Promise<void> {
    if (this.stopping) return; // prevent double shutdown
    this.stopping = true;
    console.log(`[${this.workerName}] Shutdown signal received, finishing current work...`);

    // If currently processing a message, wait briefly for it to finish
    if (this.processing) {
      console.log(`[${this.workerName}] Waiting for in-flight message to complete...`);
      const deadline = Date.now() + 10_000; // 10s grace period
      while (this.processing && Date.now() < deadline) {
        await this.sleep(250);
      }
      if (this.processing) {
        console.warn(`[${this.workerName}] Grace period expired, forcing shutdown`);
      }
    }

    await this.cleanup();
    process.exit(0);
  }

  /**
   * Close MongoDB and Redis connections. Subclasses can override to add
   * additional cleanup (e.g., killing child processes).
   */
  protected async cleanup(): Promise<void> {
    try {
      if (this.logPublisher) {
        await this.logPublisher.close();
        console.log(`[${this.workerName}] Redis connection closed`);
      }
    } catch (err) {
      console.warn(`[${this.workerName}] Error closing Redis:`, err);
    }
    try {
      if (this.heartbeatStore) {
        await this.heartbeatStore.close();
      }
    } catch (err) {
      console.warn(`[${this.workerName}] Error closing heartbeat store:`, err);
    }
    try {
      await this.mongoClient.close();
      console.log(`[${this.workerName}] MongoDB connection closed`);
    } catch (err) {
      console.warn(`[${this.workerName}] Error closing MongoDB:`, err);
    }
  }

  async start(): Promise<void> {
    console.log(`[${this.workerName}] Starting worker...`);
    console.log(`[${this.workerName}] Instance: ${this.instanceId}${this.podName ? ` (pod=${this.podName})` : ""}`);
    console.log(`[${this.workerName}] MongoDB: ${this.config.mongoUri.replace(/\/\/[^:]+:[^@]+@/, "//***:***@")}`);
    console.log(`[${this.workerName}] Queue: ${this.config.storageAccountName}/${this.config.queueName}`);
    console.log(`[${this.workerName}] Redis: ${this.config.redisHost}:${this.config.redisPort}`);

    // Ensure queue exists (creates it in Azurite on first run)
    await this.queueClient.createIfNotExists();
    console.log(`[${this.workerName}] Ensured queue exists: ${this.config.queueName}`);

    // Connect to MongoDB
    await this.mongoClient.connect();
    this.db = this.mongoClient.db(this.config.mongoDatabase);
    this.collection = this.db.collection<TDocument>(this.config.mongoCollection);
    console.log(`[${this.workerName}] Connected to MongoDB`);

    // Initialize log publisher
    const blobStorage = new BlobStorage({
      storageAccountName: this.config.storageAccountName,
      storageConnectionString: this.config.storageConnectionString,
    });
    this.logPublisher = new LogPublisher(
      {
        redisHost: this.config.redisHost,
        redisPort: this.config.redisPort,
        redisPassword: this.config.redisPassword,
      },
      blobStorage,
      this.workerName
    );

    // Per-run liveness heartbeat store. Reuses the same Redis instance as
    // log publishing; sharing the host is fine because heartbeat ops are
    // small and infrequent compared to log streaming.
    if (!this.heartbeatStore) {
      this.heartbeatStore = new RedisHeartbeatStore({
        redisHost: this.config.redisHost,
        redisPort: this.config.redisPort,
        redisPassword: this.config.redisPassword,
      }, {
        ttlMs: process.env.SCOPE_RUN_HEARTBEAT_REDIS_TTL_MS
          ? Number(process.env.SCOPE_RUN_HEARTBEAT_REDIS_TTL_MS)
          : undefined,
      });
    }

    while (!this.stopping) {
      try {
        const response = await this.queueClient.receiveMessages({
          numberOfMessages: this.config.batchSize,
          visibilityTimeout: 30,
        });

        const messages = response.receivedMessageItems;

        if (messages.length > 0) {
          console.log(`[${this.workerName}] Received ${messages.length} message(s)`);

          for (const message of messages) {
            if (this.stopping) break;
            this.processing = true;
            try {
              await this.processMessage(message);
            } finally {
              this.processing = false;
            }
          }
        }
      } catch (error) {
        if (this.stopping) break;
        console.error(`[${this.workerName}] Error polling queue:`, error);
      }

      if (!this.stopping) {
        await this.sleep(this.config.pollIntervalMs);
      }
    }

    console.log(`[${this.workerName}] Poll loop exited`);
    await this.cleanup();
  }

  private async processMessage(message: DequeuedMessageItem): Promise<void> {
    let documentId: string | undefined;
    let runId: string | undefined;
    let currentPopReceipt = message.popReceipt;
    let payload: Record<string, unknown> | undefined;
    let heartbeat: VisibilityHeartbeat | undefined;

    try {
      const decodedContent = Buffer.from(message.messageText, "base64").toString("utf-8");
      payload = JSON.parse(decodedContent);
      documentId = this.extractDocumentId(payload!);

      console.log(`[${this.workerName}] Processing document ${documentId}`);

      const doc = await withRetry(() => this.collection.findOne({ _id: documentId } as any));

      if (!doc) {
        console.error(`[${this.workerName}] Document ${documentId} not found`);
        await this.safeDeleteMessage(message.messageId, currentPopReceipt);
        return;
      }

      // Resolve the runId for log persistence. Prefer the runId carried in
      // the queue message (set by the API for new attempts); fall back to
      // the runId currently on the document, then to the documentId itself
      // (legacy / pre-migration safety).
      const payloadRunId = typeof payload?.runId === "string" ? payload.runId : undefined;
      const docRunId = typeof (doc as any)?.run?._id === "string" ? (doc as any).run._id : undefined;
      const logRunId = payloadRunId ?? docRunId ?? documentId!;
      runId = logRunId;

      // Create log function for this document
      const log = async (
        level: LogEvent["level"],
        msg: string,
        data?: Record<string, unknown>
      ): Promise<void> => {
        await this.logPublisher.publish(documentId!, logRunId, level, msg, data);
      };

      // Start the visibility heartbeat as soon as we commit to processing this
      // message. Doing this in the base class (rather than inside handleRequest)
      // covers all pre-handler work — MCP/skill/extension resolution, status
      // updates, etc. — so the original 30 s receive timeout cannot expire and
      // let another worker pick up the message in parallel.
      heartbeat = startVisibilityHeartbeat(
        this.queueClient,
        message.messageId,
        currentPopReceipt,
        this.workerName,
        undefined,
        undefined,
        { documentId, runId: logRunId },
        // Bump the per-run liveness heartbeat in Redis on every successful
        // tick so the redelivery handler can distinguish a real worker crash
        // from a spurious queue redelivery. Stored in Redis (not Mongo) to
        // avoid the recurring CosmosDB RU cost of writing every 15 s for
        // every active run.
        async () => {
          await this.heartbeatStore.set(logRunId, new Date());
          // Fallback cancel check: if the Pub/Sub message was missed (e.g.
          // Redis reconnect gap), the cancel key will be detected here within
          // 15s of being set.
          if (await this.heartbeatStore.isCancelled(logRunId)) {
            console.log(
              `[${this.workerName}] Run ${logRunId} cancel detected via key fallback — exiting process`,
            );
            cancelExit();
          }
        },
      );

      try {
        await this.handleRequest(doc as TDocument, message, heartbeat, log, payload);
      } finally {
        // Stop the heartbeat first so the latest pop receipt is stable before
        // any subsequent safeDeleteMessage call (success path delete happens
        // inside handleRequest; error path delete happens in the catch below).
        currentPopReceipt = heartbeat.stop();
        heartbeat = undefined;
      }
    } catch (error) {
      console.error(`[${this.workerName}] Error processing message:`, error);

      // Defensive: if handleRequest threw before the inner finally ran (it
      // shouldn't, but guard anyway), stop the heartbeat now.
      if (heartbeat) {
        currentPopReceipt = heartbeat.stop();
        heartbeat = undefined;
      }

      if (documentId) {
        try {
          // Best-effort runId resolution for the failure log line. Same
          // resolution order as the success path above.
          const payloadRunId = typeof payload?.runId === "string" ? payload.runId : undefined;
          await this.logPublisher.publish(
            documentId,
            payloadRunId ?? documentId,
            "error",
            `Processing failed: ${error instanceof Error ? error.message : String(error)}`,
            { final: true }
          );

          // Try to record the failure on the current run (run.* shape).
          // The runId in the queue message ensures we don't overwrite a run
          // that was started by a concurrent retry.
          const runId = (typeof payload?.runId === "string" ? payload.runId : undefined);
          const errMsg = error instanceof Error ? error.message : String(error);
          let updated = false;
          if (runId) {
            const result = await withRetry(() => this.collection.updateOne(
              { _id: documentId, "run._id": runId } as any,
              {
                $set: {
                  "run.status": "done",
                  "run.outcome": "failed",
                  "run.error": errMsg,
                  "run.finishedAt": new Date(),
                  "run.updatedAt": new Date(),
                  updatedAt: new Date(),
                },
              } as any
            ));
            updated = (result.matchedCount ?? 0) > 0;
            if (updated) {
              // Run is terminal — drop the Redis liveness heartbeat.
              await this.heartbeatStore.delete(runId);
              await this.onRunTerminal(documentId, runId);
            }
          }
          if (!updated) {
            // Legacy fallback: top-level fields (pre-migration / no runId in message).
            await withRetry(() => this.collection.updateOne(
              { _id: documentId } as any,
              {
                $set: {
                  status: "done",
                  outcome: "failed",
                  error: errMsg,
                  updatedAt: new Date(),
                },
              } as any
            ));
          }
        } catch (updateError) {
          console.error(`[${this.workerName}] Failed to update document as failed:`, updateError);
        }
      }

      await this.safeDeleteMessage(message.messageId, currentPopReceipt);
    } finally {
      // Evict the per-run blob init cache entry so initializedBlobs doesn't
      // grow unbounded over the lifetime of a long-running worker process.
      if (documentId) {
        this.logPublisher.evictRun(documentId, runId ?? documentId);
      }
    }
  }

  /**
   * Extract the document ID from the decoded queue message payload.
   * Override in subclasses if the payload uses a different field name.
   * Default: `payload.requestId`
   */
  protected extractDocumentId(payload: Record<string, unknown>): string {
    return payload.requestId as string;
  }

  /**
   * Process a document fetched from MongoDB. Subclasses must implement this.
   * The decoded payload is passed through so subclasses can extract additional
   * routing fields (e.g. runId for the run-retry-attempts feature).
   *
   * The {@link VisibilityHeartbeat} owns the live pop receipt — subclasses
   * MUST use `heartbeat.popReceipt` (not the original `message.popReceipt`)
   * when calling `safeDeleteMessage` on the success path. The base class
   * stops the heartbeat after `handleRequest` returns or throws.
   */
  protected abstract handleRequest(
    doc: TDocument,
    message: DequeuedMessageItem,
    heartbeat: VisibilityHeartbeat,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
    payload?: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Hook called when a run reaches terminal state ("done").
   * Override in subclasses to trigger follow-up actions (e.g. post-processing).
   * Default implementation is a no-op.
   */
  protected async onRunTerminal(_requestId: string, _runId: string): Promise<void> {
    // No-op by default — subclasses can override
  }

  /**
   * Delete a queue message, logging a warning instead of throwing on failure.
   */
  protected async safeDeleteMessage(messageId: string, popReceipt: string): Promise<void> {
    try {
      await this.queueClient.deleteMessage(messageId, popReceipt);
    } catch (error) {
      console.warn(`[${this.workerName}] Failed to delete queue message (may have expired or been reprocessed): ${error}`);
    }
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
