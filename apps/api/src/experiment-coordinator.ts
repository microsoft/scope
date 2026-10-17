// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import type { Collection, Document } from "mongodb";
import {
  DependencyGraph,
  ExperimentStore,
  FixedPayloadStore,
  fingerprintExperimentPayload,
  type ExperimentBlocker,
  type ExperimentDocument,
  type ExperimentExecutionHistoryDocument,
  type ExperimentHandlerServiceDocument,
  type ExperimentQueueMessagePayload,
  type ExperimentRequestState,
  type HandlerRunStatus,
  type HandlerServiceDocument,
  type RequestDocument,
  type ServiceHandlerDocument,
} from "shared";
import { ExperimentMembershipCoordinator } from "./experiment-membership.js";

export interface ExperimentCoordinatorCollections {
  requests: Collection<RequestDocument>;
  experiments: Collection<ExperimentDocument>;
  executions: Collection<ExperimentExecutionHistoryDocument>;
  chunks: Collection;
  services: Collection<ServiceHandlerDocument>;
}

export interface ExperimentDispatchMessage
  extends ExperimentQueueMessagePayload {
  projectId: string;
  handlerId: string;
  handlerVersion: number;
  claimToken: string;
  executionVersion: number;
}

export type EnqueueExperiment = (
  service: ExperimentHandlerServiceDocument,
  message: ExperimentDispatchMessage,
) => Promise<void>;

export type ExperimentReadiness =
  | "empty"
  | "waiting"
  | "blocked"
  | "ready"
  | "processing"
  | "done"
  | "failed";

export interface ReconcileExperimentResult {
  experiment: ExperimentDocument;
  readiness: ExperimentReadiness;
  rolled: boolean;
  dispatched: boolean;
}

function namedHandlerState(
  handlerId: string,
  handlers: readonly HandlerServiceDocument[],
  status: Record<string, HandlerRunStatus> | undefined,
): "waiting" | "ready" | "failed" | "blocked" {
  const direct = status?.[handlerId]?.status;
  if (direct === "done") return "ready";
  if (direct === "failed") return "failed";
  if (!handlers.some((handler) => handler._id === handlerId)) return "waiting";
  const graph = new DependencyGraph(
    handlers.map((handler) => ({
      id: handler._id,
      dependsOn: handler.dependsOn,
    })),
  );
  for (const ancestorId of graph.getAncestors(handlerId)) {
    if (status?.[ancestorId]?.status === "failed") return "blocked";
  }
  return "waiting";
}

function currentReadiness(
  experiment: ExperimentDocument,
): ExperimentReadiness {
  if (experiment.execution.requests.entryCount === 0) return "empty";
  if (experiment.execution.discardedAt) return "failed";
  if (
    experiment.execution.blocking.some(
      (blocker) => blocker.reason === "dependency-failed",
    )
  ) {
    return "failed";
  }
  if (
    experiment.execution.blocking.length > 0 &&
    experiment.execution.blocking.every(
      (blocker) => blocker.reason === "dependency-not-ready",
    )
  ) {
    return "waiting";
  }
  if (experiment.execution.blocking.length > 0) return "blocked";
  const statuses = Object.values(experiment.execution.handlerSummary);
  if (statuses.some((status) => status.status === "failed")) return "failed";
  if (
    statuses.some(
      (status) =>
        status.status === "queued" || status.status === "processing",
    )
  ) {
    return "processing";
  }
  if (
    statuses.length > 0 &&
    statuses.every((status) => status.status === "done")
  ) {
    return "done";
  }
  return statuses.length === 0 ? "ready" : "waiting";
}

function sameProjection(
  left: readonly ExperimentRequestState[],
  right: readonly ExperimentRequestState[],
): boolean {
  return fingerprintExperimentPayload(left) === fingerprintExperimentPayload(right);
}

export class ExperimentCoordinator {
  private readonly store: ExperimentStore;
  private readonly payloads: FixedPayloadStore;
  private readonly membership: ExperimentMembershipCoordinator;

  constructor(
    private readonly collections: ExperimentCoordinatorCollections,
    private readonly enqueue?: EnqueueExperiment,
  ) {
    this.store = new ExperimentStore({
      experiments: collections.experiments,
      executions: collections.executions,
      chunks: collections.chunks,
    });
    this.payloads = new FixedPayloadStore(collections.chunks);
    this.membership = new ExperimentMembershipCoordinator(collections);
  }

  async reconcile(
    projectId: string,
    experimentId: string,
  ): Promise<ReconcileExperimentResult | null> {
    let rolled = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let experiment = await this.store.get(projectId, experimentId);
      if (!experiment) return null;
      if (experiment.execution.rollover) {
        if (experiment.execution.rollover.reason === "membership") {
          experiment = (
            await this.membership.repair(projectId, experimentId)
          ).experiment;
        } else {
          const repaired = await this.store.repairRollover(
            projectId,
            experimentId,
          );
          if (!repaired) return null;
          experiment = repaired;
        }
        rolled = true;
      }

      const requests = await this.readRequests(experiment);
      const requestDocs = await this.collections.requests
        .find({
          _id: { $in: requests.map((request) => request.requestId) },
          projectId,
          deletedAt: { $exists: false },
        } as Document)
        .toArray();
      const byId = new Map(requestDocs.map((request) => [request._id, request]));
      const runVectorChanged = requests.some((request) => {
        const current = byId.get(request.requestId);
        return current?.run?._id !== request.runId;
      });
      const handlers = await this.loadRunHandlers();

      if (runVectorChanged) {
        const nextRequests = requests.map((request) => {
          const current = byId.get(request.requestId);
          if (!current?.run || current.run._id === request.runId) return request;
          return this.projectRequest(
            request.requestId,
            current.run._id,
            current,
            handlers,
          );
        });
        const frozen = await this.store.freezeCurrent({
          projectId,
          experimentId,
          experimentExecutionId:
            experiment.execution.experimentExecutionId,
          expectedExecutionVersion: experiment.execution.version,
        });
        if (!frozen) {
          const latest = await this.store.get(projectId, experimentId);
          if (
            !latest ||
            latest.execution.experimentExecutionId !==
              experiment.execution.experimentExecutionId
          ) {
            return latest
              ? {
                  experiment: latest,
                  readiness: currentReadiness(latest),
                  rolled: true,
                  dispatched: false,
                }
              : null;
          }
          continue;
        }
        const next = await this.store.rollover({
          projectId,
          experimentId,
          expectedExperimentExecutionId:
            experiment.execution.experimentExecutionId,
          expectedExecutionVersion: frozen.execution.version,
          nextExperimentExecutionId: randomUUID(),
          requests: nextRequests,
          reason: "rollover",
        });
        if (!next) continue;
        rolled = true;
        continue;
      }

      const projected = requests.map((request) =>
        this.projectRequest(
          request.requestId,
          request.runId,
          byId.get(request.requestId),
          handlers,
        ),
      );
      const blockers = projected
        .flatMap((request) => request.blockers)
        .slice(0, 32);
      if (!sameProjection(requests, projected)) {
        const projectionFingerprint = fingerprintExperimentPayload(projected);
        const updated = await this.store.casUpdateRequestStates({
          projectId,
          experimentId,
          experimentExecutionId:
            experiment.execution.experimentExecutionId,
          expectedExecutionVersion: experiment.execution.version,
          updateId: `projection:${projectionFingerprint}`,
          requests: projected,
        });
        if (updated.status === "stale" || updated.status === "contention") {
          continue;
        }
        if (updated.status === "invariant") {
          throw new Error(
            `Experiment ${experimentId} projection invariant failed: ${updated.message}`,
          );
        }
        if (updated.status === "partial-failure") {
          throw new Error(
            `Experiment ${experimentId} projection update ${updated.updateId} is incomplete: ${updated.message}`,
          );
        }
        experiment = updated.experiment;
      }
      if (
        fingerprintExperimentPayload(experiment.execution.blocking) !==
        fingerprintExperimentPayload(blockers)
      ) {
        const updated = await this.collections.experiments.findOneAndUpdate(
          {
            _id: experimentId,
            projectId,
            "execution.experimentExecutionId":
              experiment.execution.experimentExecutionId,
            "execution.version": experiment.execution.version,
          } as Document,
          {
            $set: {
              "execution.blocking": blockers,
              "execution.updatedAt": new Date(),
              updatedAt: new Date(),
            },
            $inc: { "execution.version": 1, stateVersion: 1 },
          } as Document,
          { returnDocument: "after" },
        );
        if (!updated) continue;
        experiment = updated;
      }

      const dispatch = await this.dispatchReadyHandlers(experiment, projected);
      const latest =
        (await this.store.get(projectId, experimentId)) ?? experiment;
      return {
        experiment: latest,
        readiness: currentReadiness(latest),
        rolled,
        dispatched: dispatch,
      };
    }
    throw new Error(
      `Experiment ${experimentId} invariant failure after bounded same-identity contention`,
    );
  }

  async recoverInterruptedCreations(limit = 30): Promise<number> {
    const candidates = await this.collections.requests
      .find({
        experimentId: { $exists: true },
        experimentExpectedRequestCount: { $exists: true },
        experimentFinalizedAt: { $exists: false },
        deletedAt: { $exists: false },
      } as Document)
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
    let recovered = 0;
    for (const experimentId of new Set(
      candidates.flatMap((request) =>
        request.experimentId ? [request.experimentId] : [],
      ),
    )) {
      const member = candidates.find(
        (request) => request.experimentId === experimentId,
      );
      if (!member) continue;
      const raw = await this.collections.experiments.findOne({
        _id: experimentId,
        projectId: member.projectId,
      } as Document);
      if (!raw) continue;
      const existing =
        raw.finalizedAt
          ? raw
          : await this.store.finalizeCreation({
              projectId: member.projectId,
              experimentId,
              expectedExperimentExecutionId:
                raw.execution.experimentExecutionId,
              expectedStateVersion: raw.stateVersion,
            });
      if (!existing) continue;
      await this.collections.requests.updateMany(
        {
          projectId: member.projectId,
          experimentId,
          experimentFinalizedAt: { $exists: false },
        } as Document,
        { $set: { experimentFinalizedAt: new Date() } } as Document,
      );
      recovered += 1;
    }
    return recovered;
  }

  async recoverInterruptedMemberships(limit = 30): Promise<number> {
    const candidates = await this.collections.experiments
      .find({
        finalizedAt: { $exists: true },
        "execution.rollover.reason": "membership",
      } as Document)
      .sort({ _id: 1 })
      .limit(limit)
      .project({ _id: 1, projectId: 1 })
      .toArray();
    let recovered = 0;
    for (const candidate of candidates) {
      await this.membership.repair(candidate.projectId, candidate._id);
      recovered += 1;
    }
    return recovered;
  }

  private async readRequests(
    experiment: ExperimentDocument,
  ): Promise<ExperimentRequestState[]> {
    return this.payloads.readRequests(
      {
        projectId: experiment.projectId,
        experimentId: experiment.experimentId,
        ownerId: experiment.execution.experimentExecutionId,
        generation: experiment.execution.attemptNumber,
      },
      experiment.execution.requests,
    );
  }

  private async loadRunHandlers(): Promise<HandlerServiceDocument[]> {
    const docs = await this.collections.services
      .find({ type: "post-process-handler" } as Document)
      .toArray();
    return docs.filter(
      (doc): doc is HandlerServiceDocument =>
        doc.type === "post-process-handler",
    );
  }

  private async loadExperimentHandlers(): Promise<
    ExperimentHandlerServiceDocument[]
  > {
    const docs = await this.collections.services
      .find({ type: "experiment-handler" } as Document)
      .toArray();
    return docs.filter(
      (doc): doc is ExperimentHandlerServiceDocument =>
        doc.type === "experiment-handler",
    );
  }

  private projectRequest(
    requestId: string,
    runId: string,
    request: RequestDocument | undefined,
    handlers: readonly HandlerServiceDocument[],
  ): ExperimentRequestState {
    if (!request?.run) {
      return {
        requestId,
        runId,
        dependencies: [],
        blockers: [
          {
            requestId,
            runId,
            handlerId: "request",
            reason: "request-missing",
          },
        ],
      };
    }
    const experimentHandlers = request.run.handlerStatus ?? {};
    const dependencyIds = handlers
      .filter((handler) => handler.selector === "observations")
      .map((handler) => handler._id);
    const effectiveDependencyIds =
      dependencyIds.length > 0 ? dependencyIds : ["pp-observations"];
    const dependencies = effectiveDependencyIds.map((handlerId) => {
      const source = experimentHandlers[handlerId];
      const state = namedHandlerState(
        handlerId,
        handlers,
        request.run?.handlerStatus,
      );
      return {
        handlerId,
        state,
        ...(source?.version !== undefined ? { version: source.version } : {}),
        ...(source?.updatedAt ? { updatedAt: source.updatedAt } : {}),
        ...(source?.error ? { error: source.error } : {}),
      };
    });
    const blockers: ExperimentBlocker[] = dependencies.flatMap((dependency) => {
      if (dependency.state === "ready") return [];
      const reason =
        dependency.state === "failed"
          ? ("dependency-failed" as const)
          : dependency.state === "blocked"
            ? ("dependency-blocked" as const)
            : ("dependency-not-ready" as const);
      return [
        {
          requestId,
          runId,
          handlerId: dependency.handlerId,
          reason,
          ...(dependency.error ? { error: dependency.error } : {}),
        },
      ];
    });
    return { requestId, runId, dependencies, blockers };
  }

  private async dispatchReadyHandlers(
    experiment: ExperimentDocument,
    requests: readonly ExperimentRequestState[],
  ): Promise<boolean> {
    if (!this.enqueue || requests.length === 0) return false;
    const services = await this.loadExperimentHandlers();
    let dispatched = false;
    for (const service of services) {
      const existing = experiment.execution.handlerSummary[service._id];
      const allReady = requests.every((request) =>
        service.dependsOn.every(
          (handlerId) =>
            request.dependencies.find(
              (dependency) => dependency.handlerId === handlerId,
            )?.state === "ready",
        ),
      );
      const retryDroppedNotice =
        existing?.status === "queued" &&
        Date.now() - existing.updatedAt.getTime() >= 30_000;
      if ((!existing && !allReady) || (existing && !retryDroppedNotice)) continue;

      const claimToken = existing?.claimToken ?? randomUUID();
      const now = new Date();
      let current = experiment;
      if (!existing) {
        const path = `execution.handlerSummary.${service._id}`;
        const queued = await this.collections.experiments.findOneAndUpdate(
          {
            _id: experiment.experimentId,
            projectId: experiment.projectId,
            "execution.experimentExecutionId":
              experiment.execution.experimentExecutionId,
            "execution.version": experiment.execution.version,
            [`${path}.status`]: { $exists: false },
          } as Document,
          {
            $set: {
              [path]: {
                status: "queued",
                version: service.version,
                claimToken,
                updatedAt: now,
              },
              "execution.updatedAt": now,
              updatedAt: now,
            },
            $inc: { "execution.version": 1, stateVersion: 1 },
          } as Document,
          { returnDocument: "after" },
        );
        if (!queued) continue;
        current = queued;
      }
      await this.enqueue(service, {
        type: service.selector,
        projectId: current.projectId,
        experimentId: current.experimentId,
        experimentExecutionId:
          current.execution.experimentExecutionId,
        handlerId: service._id,
        handlerVersion: service.version,
        claimToken,
        executionVersion: current.execution.version,
      });
      dispatched = true;
    }
    return dispatched;
  }
}
