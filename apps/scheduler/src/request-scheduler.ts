// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { QueueClient } from "@azure/storage-queue";
import type { Collection } from "mongodb";
import { withRetry, type CodingAgentDocument, type RequestDocument } from "shared";
import { trackEvent, trackMetric } from "telemetry";

export type QueueClientFactory = (queueName: string) => QueueClient;

export interface RequestSchedulerOptions {
  pollIntervalMs?: number;
  targetQueueDepth?: number;
  queueReconciliationIntervalMs?: number;
  invalidTargetReportIntervalMs?: number;
}

interface RegistryTarget {
  workerType: string;
  agentVersion: string;
  queueName: string;
}

interface QueueTarget {
  queueName: string;
  targets: RegistryTarget[];
}

interface QueuedTargetGroup {
  _id: {
    workerType?: string;
    agentVersion?: string;
    queuedQueueName?: string | null;
  };
  count: number;
}

/**
 * Dispatch pending requests exclusively through active targets advertised by
 * the agent registry. The registry is refreshed every cycle, so registrations,
 * availability changes, version changes, and queue changes take effect without
 * restarting the scheduler.
 */
export class RequestScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private dispatching = false;
  private readonly queueClients = new Map<string, Promise<QueueClient>>();
  private readonly pollIntervalMs: number;
  private readonly targetQueueDepth: number;
  private readonly queueReconciliationIntervalMs: number;
  private readonly invalidTargetReportIntervalMs: number;
  private queuedCountsByTarget = new Map<string, number>();
  private lastQueueReconciliationAt: number | undefined;
  private invalidTargetSignature = "";
  private lastInvalidTargetReportAt = 0;
  private conflictingTargetKeys = new Set<string>();
  private queueConflictSignature = "";

  constructor(
    private readonly requestCollection: Collection<RequestDocument>,
    private readonly agentCollection: Collection<CodingAgentDocument>,
    private readonly createQueueClient: QueueClientFactory,
    options: RequestSchedulerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.targetQueueDepth = options.targetQueueDepth ?? 5;
    this.queueReconciliationIntervalMs =
      options.queueReconciliationIntervalMs ?? 30_000;
    this.invalidTargetReportIntervalMs =
      options.invalidTargetReportIntervalMs ?? 30_000;
  }

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
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    const cycleStart = Date.now();
    let totalDispatched = 0;

    try {
      const agents = await this.agentCollection.find({}).toArray();
      const queueTargets = this.buildQueueTargets(agents);
      const queuedCountsByTarget =
        await this.maybeReconcileQueuedTargets(queueTargets);

      for (const queueTarget of queueTargets) {
        try {
          totalDispatched += await this.dispatchForQueue(
            queueTarget,
            queuedCountsByTarget,
          );
        } catch (error) {
          console.error(
            `[Scheduler] Error dispatching queue "${queueTarget.queueName}":`,
            error,
          );
        }
      }

      await this.maybeReportInvalidPendingTargets(agents, queueTargets);
    } catch (error) {
      console.error("[Scheduler] Failed to refresh agent registry:", error);
      trackEvent({
        name: "scheduler.registry_refresh_failed",
        properties: { error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      this.dispatching = false;
      trackMetric({
        name: "scheduler.dispatch_cycle_ms",
        value: Date.now() - cycleStart,
        properties: { service: "scheduler" },
      });
      if (totalDispatched > 0) {
        trackMetric({
          name: "scheduler.requests_dispatched",
          value: totalDispatched,
          properties: { service: "scheduler" },
        });
      }
    }
  }

  private buildQueueTargets(agents: CodingAgentDocument[]): QueueTarget[] {
    const targetsByKey = new Map<string, RegistryTarget>();
    const routableTargetKeys = new Set<string>();
    const conflictingTargetKeys = new Set<string>();

    for (const agent of agents) {
      if (agent.deletedAt) continue;

      for (const version of agent.versions ?? []) {
        const queueName = version.queueName?.trim();
        if (version.status !== "active" || !queueName) continue;

        const target: RegistryTarget = {
          workerType: agent._id,
          agentVersion: version.agentVersion,
          queueName,
        };
        const targetKey = this.targetKey(target.workerType, target.agentVersion);
        if (conflictingTargetKeys.has(targetKey)) continue;

        const existing = targetsByKey.get(targetKey);
        if (existing && existing.queueName !== queueName) {
          targetsByKey.delete(targetKey);
          conflictingTargetKeys.add(targetKey);
          continue;
        }
        targetsByKey.set(targetKey, target);
        if (agent.available === true) {
          routableTargetKeys.add(targetKey);
        }
      }
    }

    const targetsByQueue = new Map<string, Map<string, RegistryTarget>>();

    for (const [targetKey, target] of targetsByKey) {
      const queueTargets =
        targetsByQueue.get(target.queueName) ?? new Map<string, RegistryTarget>();
      queueTargets.set(targetKey, target);
      targetsByQueue.set(target.queueName, queueTargets);
    }

    const queueConflicts = [...targetsByQueue.entries()]
      .filter(([, targets]) => targets.size > 1)
      .map(([queueName, targets]) => ({
        queueName,
        targets: [...targets.values()].map((target) =>
          this.targetKey(target.workerType, target.agentVersion),
        ),
      }))
      .sort((left, right) => left.queueName.localeCompare(right.queueName));

    for (const conflict of queueConflicts) {
      for (const targetKey of conflict.targets) {
        conflictingTargetKeys.add(targetKey);
      }
      targetsByQueue.delete(conflict.queueName);
    }
    this.conflictingTargetKeys = conflictingTargetKeys;

    const conflictSignature = JSON.stringify(queueConflicts);
    if (conflictSignature !== this.queueConflictSignature) {
      this.queueConflictSignature = conflictSignature;
      for (const conflict of queueConflicts) {
        console.error(
          `[Scheduler] Refusing conflicting queue "${conflict.queueName}" claimed by ` +
            conflict.targets.join(", "),
        );
        trackEvent({
          name: "scheduler.registry_queue_conflict",
          properties: {
            queueName: conflict.queueName,
            targets: conflict.targets.join(","),
          },
        });
      }
    }

    return [...targetsByQueue.entries()]
      .filter(([, targets]) =>
        [...targets.keys()].some((targetKey) =>
          routableTargetKeys.has(targetKey),
        ),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([queueName, targets]) => ({
        queueName,
        targets: [...targets.values()].sort(
          (left, right) =>
            left.workerType.localeCompare(right.workerType) ||
            left.agentVersion.localeCompare(right.agentVersion),
        ),
      }));
  }

  private async maybeReportInvalidPendingTargets(
    agents: CodingAgentDocument[],
    queueTargets: QueueTarget[],
  ): Promise<void> {
    const now = Date.now();
    if (
      now - this.lastInvalidTargetReportAt <
      this.invalidTargetReportIntervalMs
    ) {
      return;
    }
    this.lastInvalidTargetReportAt = now;

    try {
      await this.reportInvalidPendingTargets(agents, queueTargets);
    } catch (error) {
      console.error("[Scheduler] Failed to inspect invalid pending targets:", error);
      trackEvent({
        name: "scheduler.invalid_target_inspection_failed",
        properties: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async reconcileQueuedTargets(
    queueTargets: QueueTarget[],
  ): Promise<Map<string, number>> {
    const expectedQueueByTarget = new Map(
      queueTargets.flatMap((queue) =>
        queue.targets.map(
          (target) =>
            [
              this.targetKey(target.workerType, target.agentVersion),
              queue.queueName,
            ] as const,
        ),
      ),
    );
    const queuedGroups = await this.requestCollection
      .aggregate<QueuedTargetGroup>([
        {
          $match: {
            "run.status": "queued",
            deletedAt: { $exists: false },
          },
        },
        {
          $group: {
            _id: {
              workerType: "$workerType",
              agentVersion: "$agentVersion",
              queuedQueueName: "$run.queuedQueueName",
            },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();
    const queuedCountsByTarget = new Map<string, number>();

    for (const group of queuedGroups) {
      const targetKey = this.targetKey(
        group._id.workerType ?? "",
        group._id.agentVersion ?? "",
      );
      const expectedQueue = expectedQueueByTarget.get(targetKey);
      const queuedQueue = group._id.queuedQueueName?.trim();
      if (expectedQueue && queuedQueue === expectedQueue) {
        queuedCountsByTarget.set(
          targetKey,
          (queuedCountsByTarget.get(targetKey) ?? 0) + group.count,
        );
        continue;
      }

      const now = new Date();
      const result = await this.requestCollection.updateMany(
        {
          "run.status": "queued",
          deletedAt: { $exists: false },
          ...(group._id.workerType
            ? { workerType: group._id.workerType }
            : { workerType: { $exists: false } }),
          ...(group._id.agentVersion
            ? { agentVersion: group._id.agentVersion }
            : { agentVersion: { $exists: false } }),
          ...(queuedQueue
            ? { "run.queuedQueueName": queuedQueue }
            : { "run.queuedQueueName": { $exists: false } }),
        } as never,
        {
          $set: {
            "run.status": "pending",
            "run.updatedAt": now,
            updatedAt: now,
          },
          $unset: { "run.queuedQueueName": "" },
        } as never,
      );
      if (result.modifiedCount > 0) {
        const reason = expectedQueue ? "queue_changed" : "target_unavailable";
        console.warn(
          `[Scheduler] Returned ${result.modifiedCount} queued request(s) to pending ` +
            `(worker=${group._id.workerType ?? "(missing)"}, ` +
            `version=${group._id.agentVersion ?? "(missing)"}, reason=${reason})`,
        );
        trackEvent({
          name: "scheduler.queued_target_reconciled",
          properties: {
            workerType: group._id.workerType ?? "",
            agentVersion: group._id.agentVersion ?? "",
            previousQueueName: queuedQueue ?? "",
            currentQueueName: expectedQueue ?? "",
            reason,
            requestCount: String(result.modifiedCount),
          },
        });
      }
    }

    return queuedCountsByTarget;
  }

  private async maybeReconcileQueuedTargets(
    queueTargets: QueueTarget[],
  ): Promise<Map<string, number>> {
    const now = Date.now();
    if (
      this.lastQueueReconciliationAt !== undefined &&
      now - this.lastQueueReconciliationAt <
        this.queueReconciliationIntervalMs
    ) {
      return this.queuedCountsByTarget;
    }

    const counts = await this.reconcileQueuedTargets(queueTargets);
    this.queuedCountsByTarget = counts;
    this.lastQueueReconciliationAt = now;
    return counts;
  }

  private async dispatchForQueue(
    queueTarget: QueueTarget,
    queuedCountsByTarget: Map<string, number>,
  ): Promise<number> {
    const target = queueTarget.targets[0];
    if (!target || queueTarget.targets.length !== 1) {
      throw new Error(
        `Queue "${queueTarget.queueName}" must have exactly one active target`,
      );
    }
    const queueClient = await this.getQueueClient(queueTarget.queueName);
    const properties = await queueClient.getProperties();
    const targetKey = this.targetKey(target.workerType, target.agentVersion);
    const queuedRequestCount = queuedCountsByTarget.get(targetKey) ?? 0;
    const physicalQueueDepth = properties.approximateMessagesCount ?? 0;
    let remainingSlots =
      this.targetQueueDepth -
      Math.max(queuedRequestCount, physicalQueueDepth);
    if (remainingSlots <= 0) return 0;

    let dispatched = 0;
    while (remainingSlots > 0) {
      const claimed = await this.requestCollection.findOneAndUpdate(
        {
          "run.status": "pending",
          deletedAt: { $exists: false },
          workerType: target.workerType,
          agentVersion: target.agentVersion,
        } as never,
        {
          $set: {
            "run.status": "queued",
            "run.queuedQueueName": queueTarget.queueName,
            "run.updatedAt": new Date(),
          },
        } as never,
        {
          sort: { priority: -1, createdAt: 1 },
          returnDocument: "after",
        },
      );
      if (!claimed) break;
      remainingSlots--;

      const message = Buffer.from(
        JSON.stringify({
          requestId: claimed._id,
          runId: claimed.run?._id,
          workerType: claimed.workerType,
          agentVersion: claimed.agentVersion,
        }),
      ).toString("base64");

      try {
        await queueClient.sendMessage(message);
      } catch (error) {
        try {
          await withRetry(
            () =>
              this.requestCollection.updateOne(
                {
                  _id: claimed._id,
                  "run._id": claimed.run?._id,
                  "run.status": "queued",
                } as never,
                {
                  $set: {
                    "run.status": "pending",
                    "run.updatedAt": new Date(),
                  },
                  $unset: { "run.queuedQueueName": "" },
                } as never,
              ),
            {
              maxRetries: 5,
              baseDelayMs: 100,
              maxDelayMs: 2_000,
              isRetryable: () => true,
              onRetry: (rollbackError, attempt) => {
                console.warn(
                  `[Scheduler] Claim rollback retry ${attempt} for ${claimed?._id}:`,
                  rollbackError,
                );
              },
            },
          );
        } catch (rollbackError) {
          console.error(
            `[Scheduler] Failed to return claim ${claimed._id} to pending after queue send failure:`,
            rollbackError,
          );
          trackEvent({
            name: "scheduler.claim_rollback_failed",
            properties: {
              requestId: claimed._id,
              runId: claimed.run?._id ?? "",
              queueName: queueTarget.queueName,
              error:
                rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError),
            },
          });
          throw new AggregateError(
            [error, rollbackError],
            `Queue send and claim rollback both failed for ${claimed._id}`,
          );
        }
        throw error;
      }

      dispatched++;
      queuedCountsByTarget.set(
        targetKey,
        (queuedCountsByTarget.get(targetKey) ?? 0) + 1,
      );
      console.log(
        `[Scheduler] queue=${queueTarget.queueName}: dispatched ${claimed._id} ` +
          `(worker=${claimed.workerType}, version=${claimed.agentVersion}, ` +
          `priority=${claimed.priority}, targetDepth=` +
          `${this.targetQueueDepth - remainingSlots}/${this.targetQueueDepth})`,
      );
    }

    return dispatched;
  }

  private async getQueueClient(queueName: string): Promise<QueueClient> {
    const existing = this.queueClients.get(queueName);
    if (existing) return existing;

    const initializing = (async () => {
      const client = this.createQueueClient(queueName);
      await client.createIfNotExists();
      console.log(`[Scheduler] Discovered queue "${queueName}" from agent registry`);
      return client;
    })();
    this.queueClients.set(queueName, initializing);

    try {
      return await initializing;
    } catch (error) {
      this.queueClients.delete(queueName);
      throw error;
    }
  }

  private async reportInvalidPendingTargets(
    agents: CodingAgentDocument[],
    queueTargets: QueueTarget[],
  ): Promise<void> {
    const validTargets = new Set(
      queueTargets.flatMap((queue) =>
        queue.targets.map((target) =>
          this.targetKey(target.workerType, target.agentVersion),
        ),
      ),
    );
    const pendingTargets = await this.requestCollection
      .aggregate<{
        _id: { workerType?: string; agentVersion?: string };
        count: number;
      }>([
        {
          $match: {
            "run.status": "pending",
            deletedAt: { $exists: false },
          },
        },
        {
          $group: {
            _id: {
              workerType: "$workerType",
              agentVersion: "$agentVersion",
            },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const agentsById = new Map(agents.map((agent) => [agent._id, agent]));
    const invalid = pendingTargets
      .filter(
        ({ _id }) =>
          !validTargets.has(
            this.targetKey(_id.workerType ?? "", _id.agentVersion ?? ""),
          ),
      )
      .map(({ _id, count }) => {
        const workerType = _id.workerType ?? "(missing)";
        const agentVersion = _id.agentVersion ?? "(missing)";
        const agent = agentsById.get(_id.workerType ?? "");
        let reason = "agent_not_found";
        if (
          this.conflictingTargetKeys.has(
            this.targetKey(_id.workerType ?? "", _id.agentVersion ?? ""),
          )
        ) {
          reason = "agent_queue_conflict";
        } else if (agent?.deletedAt) reason = "agent_deleted";
        else if (agent && agent.available !== true) reason = "agent_unavailable";
        else if (agent && !_id.agentVersion) reason = "agent_version_missing";
        else if (agent) {
          const version = (agent.versions ?? []).find(
            (candidate) => candidate.agentVersion === _id.agentVersion,
          );
          if (!version || version.status !== "active") {
            reason = "agent_version_unavailable";
          } else if (!version.queueName?.trim()) {
            reason = "agent_queue_missing";
          }
        }
        return { workerType, agentVersion, count, reason };
      })
      .sort(
        (left, right) =>
          left.workerType.localeCompare(right.workerType) ||
          left.agentVersion.localeCompare(right.agentVersion),
      );

    const signature = JSON.stringify(
      invalid.map(({ workerType, agentVersion, reason }) => ({
        workerType,
        agentVersion,
        reason,
      })),
    );
    if (signature === this.invalidTargetSignature) return;
    this.invalidTargetSignature = signature;

    for (const target of invalid) {
      console.warn(
        `[Scheduler] Leaving ${target.count} request(s) pending for invalid target ` +
          `worker=${target.workerType}, version=${target.agentVersion}: ${target.reason}`,
      );
      trackEvent({
        name: "scheduler.invalid_pending_target",
        properties: {
          workerType: target.workerType,
          agentVersion: target.agentVersion,
          reason: target.reason,
          pendingCount: String(target.count),
        },
      });
      trackMetric({
        name: "scheduler.invalid_pending_requests",
        value: target.count,
        properties: { reason: target.reason },
      });
    }
  }

  private targetKey(workerType: string, agentVersion: string): string {
    return `${workerType}\0${agentVersion}`;
  }
}
