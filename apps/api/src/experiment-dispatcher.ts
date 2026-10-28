// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { QueueClient } from "@azure/storage-queue";
import type { Collection, Db } from "mongodb";
import type {
  ExperimentDocument,
  ExperimentExecutionHistoryDocument,
  ExperimentHandlerServiceDocument,
  RequestDocument,
  ServiceHandlerDocument,
} from "shared";
import { ExperimentStore } from "shared";
import {
  ExperimentCoordinator,
  type ExperimentDispatchMessage,
} from "./experiment-coordinator.js";

export class ExperimentDispatcher {
  private interval: ReturnType<typeof setInterval> | null = null;
  private dispatching = false;
  private scanAfterExperimentId: string | null = null;
  private readonly queueClients = new Map<string, QueueClient>();
  private readonly coordinator: ExperimentCoordinator;

  constructor(
    private readonly requests: Collection<RequestDocument>,
    private readonly experiments: Collection<ExperimentDocument>,
    private readonly executions: Collection<ExperimentExecutionHistoryDocument>,
    private readonly chunks: Collection,
    db: Db,
    private readonly createQueueClient: (queueName: string) => QueueClient,
    private readonly pollIntervalMs = 30_000,
    private readonly batchSize = 30,
  ) {
    this.coordinator = new ExperimentCoordinator(
      {
        requests,
        experiments,
        executions,
        chunks,
        services: db.collection<ServiceHandlerDocument>("services"),
      },
      (service, message) => this.enqueue(service, message),
    );
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => void this.poll(), this.pollIntervalMs);
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
      { projection: { projectId: 1, experimentId: 1 } },
    );
    if (request?.experimentId) {
      await this.coordinator.reconcile(
        request.projectId,
        request.experimentId,
      );
    }
  }

  async onHandlerComplete(input: {
    projectId: string;
    experimentId: string;
    experimentExecutionId: string;
    executionVersion: number;
    handlerId: string;
    handlerVersion: number;
    claimToken: string;
    status: "done" | "failed";
    error?: string;
  }): Promise<boolean> {
    const updated = await new ExperimentStore({
      experiments: this.experiments,
      executions: this.executions,
      chunks: this.chunks,
    }).completeHandler({
      ...input,
      expectedExecutionVersion: input.executionVersion,
    });
    return updated !== null;
  }

  async onHandlerClaim(input: {
    projectId: string;
    experimentId: string;
    experimentExecutionId: string;
    executionVersion: number;
    handlerId: string;
    handlerVersion: number;
    claimToken: string;
  }): Promise<number | null> {
    const updated = await new ExperimentStore({
      experiments: this.experiments,
      executions: this.executions,
      chunks: this.chunks,
    }).claimHandler({
      ...input,
      expectedExecutionVersion: input.executionVersion,
    });
    return updated?.execution.version ?? null;
  }

  private async poll(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      await this.coordinator.recoverInterruptedCreations(this.batchSize);
      await this.coordinator.recoverInterruptedMemberships(this.batchSize);
      const candidates = await this.experiments
        .find(
          this.scanAfterExperimentId
            ? {
                _id: { $gt: this.scanAfterExperimentId },
                finalizedAt: { $exists: true },
              }
            : { finalizedAt: { $exists: true } },
        )
        .sort({ _id: 1 })
        .limit(this.batchSize)
        .project({ _id: 1, projectId: 1 })
        .toArray();
      this.scanAfterExperimentId =
        candidates.length === this.batchSize
          ? candidates.at(-1)?._id ?? null
          : null;
      for (const candidate of candidates) {
        await this.coordinator.reconcile(
          candidate.projectId,
          candidate._id,
        );
      }
    } catch (error) {
      console.error("[ExperimentDispatcher] Poll failed:", error);
    } finally {
      this.dispatching = false;
    }
  }

  private async enqueue(
    service: ExperimentHandlerServiceDocument,
    message: ExperimentDispatchMessage,
  ): Promise<void> {
    let client = this.queueClients.get(service.queue);
    if (!client) {
      client = this.createQueueClient(service.queue);
      await client.createIfNotExists();
      this.queueClients.set(service.queue, client);
    }
    await client.sendMessage(
      Buffer.from(JSON.stringify(message)).toString("base64"),
    );
  }
}
