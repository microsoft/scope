// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { DequeuedMessageItem } from "@azure/storage-queue";
import {
  BaseQueueProcessor,
  BlobStorage,
  type BaseQueueProcessorConfig,
  type LogEvent,
  type RequestDocument,
  TokenManagerClient,
  type TaxonomyDocument,
  type VisibilityHeartbeat,
  withRetry,
} from "shared";
import { generateTaxonomy } from "./taxonomy-generator.js";

const HANDLER_ID = "pp-taxonomy";
const HANDLER_VERSION = 1;
const DEFAULT_SESSION_TIMEOUT_MS = 5 * 60 * 1000;

interface TaxonomyQueueMessage {
  type: "taxonomy";
  requestId: string;
  runId?: string;
}

export interface TaxonomyQueueProcessorConfig extends BaseQueueProcessorConfig {
  taxonomyModel: string;
  apiBaseUrl: string;
  sessionTimeoutMs?: number;
  schedulerUrl?: string;
  tokenManagerUrl?: string;
}

export class TaxonomyQueueProcessor extends BaseQueueProcessor<RequestDocument> {
  private taxonomyConfig: TaxonomyQueueProcessorConfig;
  private tokenClient: TokenManagerClient;
  private blobStorage: BlobStorage;

  constructor(config: TaxonomyQueueProcessorConfig) {
    super(config, "taxonomy-handler");
    this.taxonomyConfig = config;
    this.tokenClient = new TokenManagerClient(config.tokenManagerUrl);
    this.blobStorage = new BlobStorage({
      storageAccountName: config.storageAccountName,
      storageConnectionString: config.storageConnectionString,
    });
  }

  protected override async handleRequest(
    doc: RequestDocument,
    message: DequeuedMessageItem,
    heartbeat: VisibilityHeartbeat,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const queueMessage = payload as TaxonomyQueueMessage | undefined;
    const requestId = doc._id;
    const activeRunId = doc.run?._id;
    const runId = queueMessage?.runId ?? activeRunId ?? requestId;

    if (!queueMessage || queueMessage.type !== "taxonomy") {
      await log("warn", "Discarding message with unsupported taxonomy payload", { payload });
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    if (queueMessage.runId && activeRunId && queueMessage.runId !== activeRunId) {
      await log("warn", "Discarding stale taxonomy message for superseded run", {
        requestId,
        queuedRunId: queueMessage.runId,
        activeRunId,
      });
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    if (!doc.run) {
      throw new Error(`Request ${requestId} has no active run to classify`);
    }

    await withRetry(() => this.collection.updateOne(
      { _id: requestId } as never,
      {
        $set: {
          [`run.handlerStatus.${HANDLER_ID}.status`]: "processing",
          [`run.handlerStatus.${HANDLER_ID}.version`]: HANDLER_VERSION,
          [`run.handlerStatus.${HANDLER_ID}.updatedAt`]: new Date(),
          [`run.handlerStatus.${HANDLER_ID}.error`]: null,
        },
      } as never,
    ));

    await log("info", "Starting taxonomy generation", { requestId, runId, model: this.taxonomyConfig.taxonomyModel });

    try {
      const taxonomy = await this.generateTaxonomy(requestId, runId, log);
      const blobName = `${requestId}/runs/${runId}/taxonomy.json`;
      const taxonomyUrl = await this.blobStorage.uploadJson(blobName, taxonomy);

      await withRetry(() => this.collection.updateOne(
        { _id: requestId } as never,
        {
          $set: {
            [`run.taxonomyUrl`]: taxonomyUrl,
            [`run.handlerStatus.${HANDLER_ID}.status`]: "done",
            [`run.handlerStatus.${HANDLER_ID}.version`]: HANDLER_VERSION,
            [`run.handlerStatus.${HANDLER_ID}.updatedAt`]: new Date(),
          },
          $unset: {
            [`run.handlerStatus.${HANDLER_ID}.error`]: "",
          },
        } as never,
      ));

      await log("info", "Taxonomy generation completed", {
        requestId,
        runId,
        blobName,
        taxonomyUrl,
      });

      await this.notifyHandlerComplete(requestId, runId, "done");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      await withRetry(() => this.collection.updateOne(
        { _id: requestId } as never,
        {
          $set: {
            [`run.handlerStatus.${HANDLER_ID}.status`]: "failed",
            [`run.handlerStatus.${HANDLER_ID}.version`]: HANDLER_VERSION,
            [`run.handlerStatus.${HANDLER_ID}.updatedAt`]: new Date(),
            [`run.handlerStatus.${HANDLER_ID}.error`]: errorMessage,
          },
        } as never,
      ));

      await log("error", `Taxonomy generation failed: ${errorMessage}`, { requestId, runId });
      await this.notifyHandlerComplete(requestId, runId, "failed");
      throw error;
    }

    const finalPopReceipt = heartbeat.stop();
    await this.safeDeleteMessage(message.messageId, finalPopReceipt);
  }

  private async generateTaxonomy(
    requestId: string,
    runId: string,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
  ): Promise<TaxonomyDocument> {
    const githubToken = await this.tokenClient.acquireToken("copilot-sdk");
    await log("info", "Acquired Copilot SDK token");

    return generateTaxonomy({
      requestId,
      runId,
      apiBaseUrl: this.taxonomyConfig.apiBaseUrl,
      taxonomyModel: this.taxonomyConfig.taxonomyModel,
      githubToken,
      sessionTimeoutMs: this.taxonomyConfig.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
      log,
    });
  }

  private async notifyHandlerComplete(
    requestId: string,
    runId: string,
    status: "done" | "failed",
  ): Promise<void> {
    const schedulerUrl = this.taxonomyConfig.schedulerUrl;
    if (!schedulerUrl) return;

    try {
      const response = await fetch(`${schedulerUrl}/notify/handler-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, runId, handlerId: HANDLER_ID, status }),
      });

      if (!response.ok) {
        console.warn(`[taxonomy-handler] Scheduler notify failed: ${response.status}`);
      }
    } catch (error) {
      console.warn(`[taxonomy-handler] Scheduler notify error for ${requestId}/${runId}:`, error);
    }
  }
}
