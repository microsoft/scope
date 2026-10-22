// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import type { Collection, Document } from "mongodb";
import {
  ExperimentLifecycleTargetStore,
  ExperimentStore,
  FixedPayloadStore,
  fingerprintExperimentPayload,
  type ExperimentDocument,
  type ExperimentExecutionHistoryDocument,
  type ExperimentLifecycleBlocker,
  type ExperimentLifecycleState,
  type ExperimentLifecycleTarget,
  type ExperimentRequestState,
  type ReportDocument,
  type RequestDocument,
} from "shared";

const TARGET_BATCH_SIZE = 500;

export class ExperimentLifecycleError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
    readonly code: string,
    readonly lifecycle?: ExperimentLifecycleState,
  ) {
    super(message);
  }
}

export interface ExperimentLifecycleCollections {
  requests: Collection<RequestDocument>;
  reports: Collection<ReportDocument>;
  experiments: Collection<ExperimentDocument>;
  executions: Collection<ExperimentExecutionHistoryDocument>;
  chunks: Collection<Document>;
}

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += TARGET_BATCH_SIZE) {
    result.push(values.slice(index, index + TARGET_BATCH_SIZE));
  }
  return result;
}

function lifecycleCounts(targets: readonly ExperimentLifecycleTarget[]) {
  return {
    expectedRequests: targets.filter((target) => target.kind === "request").length,
    completedRequests: 0,
    expectedReports: targets.filter((target) => target.kind === "report").length,
    completedReports: 0,
  };
}

export class ExperimentLifecycleCoordinator {
  private readonly store: ExperimentStore;
  private readonly targetStore: ExperimentLifecycleTargetStore;
  private readonly payloads: FixedPayloadStore;

  constructor(private readonly collections: ExperimentLifecycleCollections) {
    this.store = new ExperimentStore({
      experiments: collections.experiments,
      executions: collections.executions,
      chunks: collections.chunks,
    });
    this.targetStore = new ExperimentLifecycleTargetStore(collections.chunks);
    this.payloads = new FixedPayloadStore(collections.chunks);
  }

  async startDelete(
    projectId: string,
    experimentId: string,
    now = new Date(),
  ): Promise<ExperimentDocument> {
    const current = await this.store.getIncludingDeleted(projectId, experimentId);
    if (!current) {
      throw new ExperimentLifecycleError(
        `Experiment ${experimentId} was not found`,
        404,
        "experiment-not-found",
      );
    }
    if (
      current.lifecycle?.phase === "deleting" ||
      current.lifecycle?.phase === "deleted"
    ) {
      return this.repair(projectId, experimentId);
    }
    if (current.lifecycle?.phase === "restoring") {
      throw new ExperimentLifecycleError(
        "Experiment restore is already active",
        409,
        "experiment-lifecycle-conflict",
        current.lifecycle,
      );
    }
    if (current.execution.rollover || current.execution.requestStateUpdate) {
      throw new ExperimentLifecycleError(
        "Experiment publication is active",
        409,
        "experiment-mutation-active",
        current.lifecycle,
      );
    }

    const requestVector = await this.payloads.readRequests(
      {
        projectId,
        experimentId,
        ownerId: current.execution.experimentExecutionId,
        generation: current.execution.attemptNumber,
      },
      current.execution.requests,
    );
    const requestIds = requestVector.map(({ requestId }) => requestId);
    const activeRequests = requestIds.length === 0
      ? []
      : await this.collections.requests
        .find({
          _id: { $in: requestIds },
          projectId,
          experimentId,
          deletedAt: { $exists: false },
        } as Document)
        .project({ _id: 1 })
        .toArray();
    const activeReports = await this.collections.reports
      .find({
        projectId,
        experimentId,
        deletedAt: { $exists: false },
      } as Document)
      .project({ _id: 1 })
      .toArray();
    const targets: ExperimentLifecycleTarget[] = [
      ...activeRequests.map((request) => ({
        kind: "request" as const,
        id: request._id,
      })),
      ...activeReports.map((report) => ({
        kind: "report" as const,
        id: report._id,
      })),
    ];
    const operationId = randomUUID();
    const targetFingerprint = fingerprintExperimentPayload(targets);
    const buildLifecycle = (
      payload: ExperimentLifecycleState["targets"],
    ): ExperimentLifecycleState => ({
      operationId,
      phase: "deleting",
      stateVersion: 1,
      targets: payload,
      targetFingerprint,
      progress: lifecycleCounts(targets),
      blocking: [],
      deleteRequestedAt: now,
    });
    const payload = await this.targetStore.prepare({
      projectId,
      experimentId,
      operationId,
      targets,
      inlineDocument: (candidate) => ({
        ...current,
        lifecycle: buildLifecycle(candidate),
      }),
      now,
    });
    const lifecycle = buildLifecycle(payload);
    const claimed = await this.collections.experiments.findOneAndUpdate(
      {
        _id: experimentId,
        projectId,
        stateVersion: current.stateVersion,
        $or: [
          { lifecycle: { $exists: false } },
          { "lifecycle.phase": "restored" },
        ],
      } as Document,
      {
        $set: {
          lifecycle,
          "execution.frozenAt": current.execution.frozenAt ?? now,
          "execution.updatedAt": now,
          updatedAt: now,
        },
        $inc: {
          stateVersion: 1,
          "execution.version": current.execution.frozenAt ? 0 : 1,
        },
      } as Document,
      { returnDocument: "after" },
    );
    if (!claimed) {
      await this.targetStore.discard(payload);
      const raced = await this.store.getIncludingDeleted(projectId, experimentId);
      if (
        raced?.lifecycle?.phase === "deleting" ||
        raced?.lifecycle?.phase === "deleted"
      ) {
        return this.repair(projectId, experimentId);
      }
      throw new ExperimentLifecycleError(
        "Experiment lifecycle changed before deletion could start",
        409,
        "experiment-lifecycle-contention",
        raced?.lifecycle,
      );
    }
    return claimed;
  }

  async startRestore(
    projectId: string,
    experimentId: string,
    now = new Date(),
  ): Promise<ExperimentDocument> {
    const current = await this.store.getIncludingDeleted(projectId, experimentId);
    if (!current) {
      throw new ExperimentLifecycleError(
        `Experiment ${experimentId} was not found`,
        404,
        "experiment-not-found",
      );
    }
    if (
      current.lifecycle?.phase === "restoring" ||
      current.lifecycle?.phase === "restored"
    ) {
      return this.repair(projectId, experimentId);
    }
    if (current.lifecycle?.phase !== "deleted") {
      throw new ExperimentLifecycleError(
        "Only a deleted Experiment can be restored",
        409,
        "experiment-lifecycle-conflict",
        current.lifecycle,
      );
    }
    const updated = await this.collections.experiments.findOneAndUpdate(
      {
        _id: experimentId,
        projectId,
        stateVersion: current.stateVersion,
        "lifecycle.operationId": current.lifecycle.operationId,
        "lifecycle.phase": "deleted",
      } as Document,
      {
        $set: {
          "lifecycle.phase": "restoring",
          "lifecycle.restoreRequestedAt": now,
          "lifecycle.blocking": [],
          "lifecycle.progress.completedRequests": 0,
          "lifecycle.progress.completedReports": 0,
          updatedAt: now,
        },
        $inc: { stateVersion: 1, "lifecycle.stateVersion": 1 },
      } as Document,
      { returnDocument: "after" },
    );
    if (!updated) {
      const raced = await this.store.getIncludingDeleted(projectId, experimentId);
      if (raced?.lifecycle?.phase === "restoring") {
        return this.repair(projectId, experimentId);
      }
      throw new ExperimentLifecycleError(
        "Experiment lifecycle changed before restore could start",
        409,
        "experiment-lifecycle-contention",
        raced?.lifecycle,
      );
    }
    return updated;
  }

  async repair(
    projectId: string,
    experimentId: string,
  ): Promise<ExperimentDocument> {
    const current = await this.store.getIncludingDeleted(projectId, experimentId);
    if (!current?.lifecycle) {
      throw new ExperimentLifecycleError(
        `Experiment ${experimentId} has no lifecycle operation`,
        current ? 409 : 404,
        current ? "experiment-lifecycle-inactive" : "experiment-not-found",
      );
    }
    if (
      current.lifecycle.phase === "deleted" ||
      current.lifecycle.phase === "restored"
    ) {
      return current;
    }
    const targets = await this.targetStore.read({
      projectId,
      experimentId,
      operationId: current.lifecycle.operationId,
      payload: current.lifecycle.targets,
    });
    const requests = targets
      .filter((target) => target.kind === "request")
      .map((target) => target.id);
    const reports = targets
      .filter((target) => target.kind === "report")
      .map((target) => target.id);
    if (current.lifecycle.phase === "deleting") {
      await this.deleteTargets(current, requests, reports);
      return this.finishDelete(current, requests, reports);
    }
    await this.restoreTargets(current, requests, reports);
    return this.finishRestore(current, requests, reports);
  }

  async repairActive(limit = 30): Promise<number> {
    const roots = await this.collections.experiments
      .find({
        "lifecycle.phase": { $in: ["deleting", "restoring"] },
      } as Document)
      .sort({ updatedAt: 1 })
      .limit(limit)
      .project({ _id: 1, projectId: 1 })
      .toArray();
    for (const root of roots) {
      try {
        await this.repair(root.projectId, root._id);
      } catch (error) {
        console.error(
          `[experiment-lifecycle] Failed to repair ${root.projectId}/${root._id}:`,
          error,
        );
      }
    }
    return roots.length;
  }

  private async deleteTargets(
    experiment: ExperimentDocument,
    requestIds: readonly string[],
    reportIds: readonly string[],
  ): Promise<void> {
    const provenance = {
      kind: "experiment" as const,
      experimentId: experiment.experimentId,
      operationId: experiment.lifecycle!.operationId,
    };
    const now = new Date();
    for (const ids of batches(requestIds)) {
      await this.collections.requests.updateMany(
        {
          _id: { $in: ids },
          projectId: experiment.projectId,
          experimentId: experiment.experimentId,
          deletedAt: { $exists: false },
        } as Document,
        { $set: { deletedAt: now, deletionProvenance: provenance } } as Document,
      );
    }
    for (const ids of batches(reportIds)) {
      await this.collections.reports.updateMany(
        {
          _id: { $in: ids },
          projectId: experiment.projectId,
          experimentId: experiment.experimentId,
          deletedAt: { $exists: false },
        } as Document,
        { $set: { deletedAt: now, deletionProvenance: provenance } } as Document,
      );
    }
  }

  private async restoreTargets(
    experiment: ExperimentDocument,
    requestIds: readonly string[],
    reportIds: readonly string[],
  ): Promise<void> {
    const filter = {
      kind: "experiment",
      experimentId: experiment.experimentId,
      operationId: experiment.lifecycle!.operationId,
    };
    for (const ids of batches(requestIds)) {
      await this.collections.requests.updateMany(
        {
          _id: { $in: ids },
          projectId: experiment.projectId,
          deletionProvenance: filter,
        } as Document,
        { $unset: { deletedAt: "", deletionProvenance: "" } } as Document,
      );
    }
    for (const ids of batches(reportIds)) {
      await this.collections.reports.updateMany(
        {
          _id: { $in: ids },
          projectId: experiment.projectId,
          deletionProvenance: filter,
        } as Document,
        { $unset: { deletedAt: "", deletionProvenance: "" } } as Document,
      );
    }
  }

  private async targetState(
    experiment: ExperimentDocument,
    requestIds: readonly string[],
    reportIds: readonly string[],
    restoring: boolean,
  ): Promise<{
    completedRequests: number;
    completedReports: number;
    blocking: ExperimentLifecycleBlocker[];
  }> {
    const provenance = {
      kind: "experiment",
      experimentId: experiment.experimentId,
      operationId: experiment.lifecycle!.operationId,
    };
    const requestDocs = requestIds.length === 0
      ? []
      : await this.collections.requests
        .find({
          _id: { $in: requestIds },
          projectId: experiment.projectId,
        } as Document)
        .project({ _id: 1, deletedAt: 1, deletionProvenance: 1 })
        .toArray();
    const reportDocs = reportIds.length === 0
      ? []
      : await this.collections.reports
        .find({
          _id: { $in: reportIds },
          projectId: experiment.projectId,
        } as Document)
        .project({ _id: 1, deletedAt: 1, deletionProvenance: 1 })
        .toArray();
    const blockers: ExperimentLifecycleBlocker[] = [];
    const inspect = (
      kind: "request" | "report",
      ids: readonly string[],
      docs: Document[],
    ): number => {
      const byId = new Map(
        docs.flatMap((doc) =>
          typeof doc._id === "string" ? [[doc._id, doc] as const] : [],
        ),
      );
      let completed = 0;
      for (const id of ids) {
        const doc = byId.get(id);
        if (!doc) {
          blockers.push({ kind, id, reason: "target-missing" });
          continue;
        }
        const ownsDeletion =
          doc.deletionProvenance !== undefined &&
          fingerprintExperimentPayload(doc.deletionProvenance) ===
            fingerprintExperimentPayload(provenance);
        const done = restoring
          ? !doc.deletedAt && doc.deletionProvenance === undefined
          : Boolean(doc.deletedAt && ownsDeletion);
        if (done) {
          completed += 1;
        } else {
          blockers.push({ kind, id, reason: "target-conflict" });
        }
      }
      return completed;
    };
    return {
      completedRequests: inspect("request", requestIds, requestDocs),
      completedReports: inspect("report", reportIds, reportDocs),
      blocking: blockers.slice(0, 32),
    };
  }

  private async finishDelete(
    current: ExperimentDocument,
    requestIds: readonly string[],
    reportIds: readonly string[],
  ): Promise<ExperimentDocument> {
    const state = await this.targetState(current, requestIds, reportIds, false);
    const complete =
      state.completedRequests === requestIds.length &&
      state.completedReports === reportIds.length &&
      state.blocking.length === 0;
    const now = new Date();
    const updated = await this.collections.experiments.findOneAndUpdate(
      {
        _id: current.experimentId,
        projectId: current.projectId,
        stateVersion: current.stateVersion,
        "lifecycle.operationId": current.lifecycle!.operationId,
        "lifecycle.phase": "deleting",
        "lifecycle.stateVersion": current.lifecycle!.stateVersion,
      } as Document,
      {
        $set: {
          "lifecycle.progress.completedRequests": state.completedRequests,
          "lifecycle.progress.completedReports": state.completedReports,
          "lifecycle.blocking": state.blocking,
          ...(complete
            ? {
                "lifecycle.phase": "deleted",
                "lifecycle.deleteCompletedAt": now,
                deletedAt: now,
              }
            : {}),
          updatedAt: now,
        },
        $inc: { stateVersion: 1, "lifecycle.stateVersion": 1 },
      } as Document,
      { returnDocument: "after" },
    );
    if (!updated) return this.repair(current.projectId, current.experimentId);
    return updated;
  }

  private async finishRestore(
    current: ExperimentDocument,
    requestIds: readonly string[],
    reportIds: readonly string[],
  ): Promise<ExperimentDocument> {
    const state = await this.targetState(current, requestIds, reportIds, true);
    if (
      state.completedRequests !== requestIds.length ||
      state.completedReports !== reportIds.length ||
      state.blocking.length > 0
    ) {
      const updated = await this.collections.experiments.findOneAndUpdate(
        {
          _id: current.experimentId,
          projectId: current.projectId,
          stateVersion: current.stateVersion,
          "lifecycle.operationId": current.lifecycle!.operationId,
          "lifecycle.phase": "restoring",
          "lifecycle.stateVersion": current.lifecycle!.stateVersion,
        } as Document,
        {
          $set: {
            "lifecycle.progress.completedRequests": state.completedRequests,
            "lifecycle.progress.completedReports": state.completedReports,
            "lifecycle.blocking": state.blocking,
            updatedAt: new Date(),
          },
          $inc: { stateVersion: 1, "lifecycle.stateVersion": 1 },
        } as Document,
        { returnDocument: "after" },
      );
      return updated ?? current;
    }

    const requestVector = await this.payloads.readRequests(
      {
        projectId: current.projectId,
        experimentId: current.experimentId,
        ownerId: current.execution.experimentExecutionId,
        generation: current.execution.attemptNumber,
      },
      current.execution.requests,
    );
    const requestDocs = requestIds.length === 0
      ? []
      : await this.collections.requests
        .find({
          _id: { $in: requestIds },
          projectId: current.projectId,
          experimentId: current.experimentId,
          deletedAt: { $exists: false },
        } as Document)
        .toArray();
    const currentById = new Map(requestDocs.map((request) => [request._id, request]));
    const drifted = requestVector.some(
      (request) => currentById.get(request.requestId)?.run?._id !== request.runId,
    );
    if (drifted) {
      const nextRequests: ExperimentRequestState[] = requestVector.map((request) => {
        const runId = currentById.get(request.requestId)?.run?._id;
        return runId && runId !== request.runId
          ? { requestId: request.requestId, runId, dependencies: [], blockers: [] }
          : request;
      });
      const rolled = await this.store.rollover({
        projectId: current.projectId,
        experimentId: current.experimentId,
        expectedExperimentExecutionId: current.execution.experimentExecutionId,
        expectedExecutionVersion: current.execution.version,
        nextExperimentExecutionId: randomUUID(),
        requests: nextRequests,
        reason: "rollover",
      });
      if (!rolled) {
        const blocker: ExperimentLifecycleBlocker = {
          kind: "experiment",
          id: current.experimentId,
          reason: "reconciliation-failed",
          error: "Current request vector changed during restore reconciliation",
        };
        const updated = await this.collections.experiments.findOneAndUpdate(
          {
            _id: current.experimentId,
            projectId: current.projectId,
            stateVersion: current.stateVersion,
            "lifecycle.operationId": current.lifecycle!.operationId,
            "lifecycle.phase": "restoring",
            "lifecycle.stateVersion": current.lifecycle!.stateVersion,
          } as Document,
          {
            $set: {
              "lifecycle.blocking": [blocker],
              updatedAt: new Date(),
            },
            $inc: { stateVersion: 1, "lifecycle.stateVersion": 1 },
          } as Document,
          { returnDocument: "after" },
        );
        return updated ?? current;
      }
      current = rolled;
    }

    const now = new Date();
    const updated = await this.collections.experiments.findOneAndUpdate(
      {
        _id: current.experimentId,
        projectId: current.projectId,
        stateVersion: current.stateVersion,
        "lifecycle.operationId": current.lifecycle!.operationId,
        "lifecycle.phase": "restoring",
        "lifecycle.stateVersion": current.lifecycle!.stateVersion,
      } as Document,
      {
        $set: {
          "lifecycle.phase": "restored",
          "lifecycle.restoreCompletedAt": now,
          "lifecycle.progress.completedRequests": requestIds.length,
          "lifecycle.progress.completedReports": reportIds.length,
          "lifecycle.blocking": [],
          "execution.updatedAt": now,
          updatedAt: now,
        },
        $unset: {
          deletedAt: "",
          "execution.frozenAt": "",
        },
        $inc: {
          stateVersion: 1,
          "execution.version": 1,
          "lifecycle.stateVersion": 1,
        },
      } as Document,
      { returnDocument: "after" },
    );
    if (!updated) return this.repair(current.projectId, current.experimentId);
    return updated;
  }
}
