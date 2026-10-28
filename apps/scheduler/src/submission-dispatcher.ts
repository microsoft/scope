// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { QueueClient } from "@azure/storage-queue";
import type { Collection, Db } from "mongodb";
import {
  SubmissionCoordinator,
  type RequestDocument,
  type SubmissionDocument,
  type SubmissionHandlerServiceDocument,
  type SubmissionQueueMessagePayload,
  type SubmissionRunHistoryDocument,
  type ServiceHandlerDocument,
} from "shared";

export class SubmissionDispatcher {
  private interval: ReturnType<typeof setInterval> | null = null;
  private dispatching = false;
  private scanAfterSubmissionId: string | null = null;
  private readonly queueClients = new Map<string, QueueClient>();
  private readonly coordinator: SubmissionCoordinator;

  constructor(
    private readonly requests: Collection<RequestDocument>,
    private readonly submissions: Collection<SubmissionDocument>,
    submissionRuns: Collection<SubmissionRunHistoryDocument>,
    db: Db,
    private readonly createQueueClient: (queueName: string) => QueueClient,
    private readonly pollIntervalMs = 30_000,
    private readonly batchSize = 30,
  ) {
    this.coordinator = new SubmissionCoordinator(
      {
        requests,
        submissions,
        submissionRuns,
        services: db.collection<ServiceHandlerDocument>("services"),
      },
      (service, message) => this.enqueue(service, message),
    );
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.poll(), this.pollIntervalMs);
    void this.poll();
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    const deadline = Date.now() + 5_000;
    while (this.dispatching && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async onRequestChanged(requestId: string): Promise<void> {
    const request = await this.requests.findOne(
      { _id: requestId },
      { projection: { submissionId: 1 } },
    );
    if (request?.submissionId) {
      await this.coordinator.reconcile(request.submissionId);
    }
  }

  private async poll(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      await this.coordinator.recoverMissingNativeSubmissions(this.batchSize);
      const candidates = await this.submissions
        .find(
          this.scanAfterSubmissionId
            ? { _id: { $gt: this.scanAfterSubmissionId } }
            : {},
        )
        .sort({ _id: 1 })
        .limit(this.batchSize)
        .project({ _id: 1 })
        .toArray();
      this.scanAfterSubmissionId =
        candidates.length === this.batchSize
          ? candidates.at(-1)?._id ?? null
          : null;
      for (const candidate of candidates) {
        await this.coordinator.reconcile(candidate._id);
      }
    } catch (error) {
      console.error("[SubmissionDispatcher] Poll failed:", error);
    } finally {
      this.dispatching = false;
    }
  }

  private async enqueue(
    service: SubmissionHandlerServiceDocument,
    message: SubmissionQueueMessagePayload,
  ): Promise<void> {
    let client = this.queueClients.get(service.queue);
    if (!client) {
      client = this.createQueueClient(service.queue);
      await client.createIfNotExists();
      this.queueClients.set(service.queue, client);
    }
    const encoded = Buffer.from(JSON.stringify(message)).toString("base64");
    await client.sendMessage(encoded);
  }
}
