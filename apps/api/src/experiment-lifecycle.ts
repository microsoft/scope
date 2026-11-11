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
  type ReportDocument,
  type RequestDocument,
} from "shared";
import { currentReadiness } from "./experiment-coordinator.js";
import {
  assertTerminalDeletion,
  terminalDeletionFilter,
  TerminalDeletionError,
  type DeletionConflict,
} from "./terminal-deletion.js";

const TARGET_BATCH_SIZE = 500;

export class ExperimentLifecycleError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
    readonly code: string,
    readonly lifecycle?: ExperimentLifecycleState,
    readonly conflicts?: DeletionConflict[],
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
    if (
      current.execution.rollover ||
      current.execution.requestStateUpdate ||
      (current.execution.frozenAt && !current.execution.discardedAt)
    ) {
      throw new ExperimentLifecycleError(
        "Experiment publication is active",
        409,
        "experiment-mutation-active",
        current.lifecycle,
      );
    }
    if (current.deletedAt) {
      throw new ExperimentLifecycleError(
        "Deleted Experiment has no recoverable lifecycle",
        409,
        "experiment-lifecycle-conflict",
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
    const memberRequests = requestIds.length === 0
      ? []
      : await this.collections.requests
        .find({
          _id: { $in: requestIds },
          projectId,
        } as Document)
        .toArray();
    const activeRequests = memberRequests.filter((request) => !request.deletedAt);
    const activeReports = await this.collections.reports
      .find({
        projectId,
        $or: [
          { experimentId },
          ...(requestIds.length > 0 ? [{ requestId: { $in: requestIds } }] : []),
        ],
        deletedAt: { $exists: false },
      } as Document)
      .toArray();
    const conflicts: DeletionConflict[] = [];
    const readiness = currentReadiness(current);
    if (!["empty", "done", "failed"].includes(readiness)) {
      conflicts.push({ reason: `experiment-${readiness}` });
    }
    for (const [handlerId, handler] of Object.entries(
      current.execution.handlerSummary,
    )) {
      if (handler.status === "queued" || handler.status === "processing") {
        conflicts.push({ handlerId, reason: `handler-${handler.status}` });
      }
    }
    for (const [handlerId, report] of Object.entries(
      current.execution.reportTemplates ?? {},
    )) {
      if (["waiting", "queued", "processing"].includes(report.status)) {
        conflicts.push({
          handlerId,
          reportId: report.report?.reportId,
          reason: `report-template-${report.status}`,
        });
      }
    }
    for (const report of activeReports) {
      if (report.status === "pending" || report.status === "generating") {
        conflicts.push({ reportId: report._id, reason: `report-${report.status}` });
      }
    }
    const exactRuns = new Map(
      requestVector.map((member) => [member.requestId, member.runId]),
    );
    const membersById = new Map(
      memberRequests.map((member) => [member._id, member]),
    );
    for (const member of requestVector) {
      const request = membersById.get(member.requestId);
      if (!request || request.experimentId !== experimentId) {
        conflicts.push({
          requestId: member.requestId,
          runId: member.runId,
          reason: "member-missing-or-reassigned",
        });
      }
    }
    for (const request of activeRequests) {
      if (exactRuns.get(request._id) !== request.run?._id) {
        conflicts.push({
          requestId: request._id,
          runId: request.run?._id,
          reason: "run-changed",
        });
      }
    }
    try {
      await assertTerminalDeletion(activeRequests, this.collections.reports);
    } catch (error) {
      if (!(error instanceof TerminalDeletionError)) throw error;
      conflicts.push(...error.conflicts);
    }
    if (conflicts.length > 0) {
      throw new ExperimentLifecycleError(
        "Experiment has unfinished work or its exact member attempts changed",
        409,
        "experiment-deletion-work-active",
        undefined,
        conflicts,
      );
    }
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
        "execution.experimentExecutionId": current.execution.experimentExecutionId,
        "execution.version": current.execution.version,
        "execution.rollover": { $exists: false },
        "execution.requestStateUpdate": { $exists: false },
        lifecycle: { $exists: false },
        deletedAt: { $exists: false },
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
          "execution.version": 1,
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
      current.execution.rollover ||
      current.execution.requestStateUpdate ||
      (!current.lifecycle && current.execution.frozenAt && !current.execution.discardedAt)
    ) {
      throw new ExperimentLifecycleError(
        "Experiment publication is active",
        409,
        "experiment-mutation-active",
        current.lifecycle,
      );
    }
    if (!current.deletedAt && !current.lifecycle) return current;
    if (current.lifecycle?.phase === "restoring") {
      return current.lifecycle.targets.entryCount <= TARGET_BATCH_SIZE
        ? this.repair(projectId, experimentId)
        : current;
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
        "execution.experimentExecutionId": current.execution.experimentExecutionId,
        "execution.version": current.execution.version,
        "execution.rollover": { $exists: false },
        "execution.requestStateUpdate": { $exists: false },
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
      if (raced && !raced.deletedAt && !raced.lifecycle) return raced;
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
    return updated.lifecycle!.targets.entryCount <= TARGET_BATCH_SIZE
      ? this.repair(projectId, experimentId)
      : updated;
  }

  async repair(
    projectId: string,
    experimentId: string,
  ): Promise<ExperimentDocument> {
    const current = await this.store.getIncludingDeleted(projectId, experimentId);
    if (current && !current.lifecycle && !current.deletedAt) return current;
    if (!current?.lifecycle) {
      throw new ExperimentLifecycleError(
        `Experiment ${experimentId} has no lifecycle operation`,
        current ? 409 : 404,
        current ? "experiment-lifecycle-inactive" : "experiment-not-found",
      );
    }
    if (current.lifecycle.phase === "deleted") {
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
      const blocking = await this.deleteTargets(current, requests, reports);
      return this.finishDelete(current, requests, reports, blocking);
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

  /** CAS losers may follow the same operation or its completed active result,
   * never a later delete/restore intent that reused this Experiment ID. */
  private async resume(current: ExperimentDocument): Promise<ExperimentDocument> {
    const latest = await this.store.getIncludingDeleted(
      current.projectId,
      current.experimentId,
    );
    if (!latest) {
      throw new ExperimentLifecycleError(
        "Experiment disappeared during lifecycle repair",
        404,
        "experiment-not-found",
      );
    }
    if (
      current.lifecycle?.phase === "restoring" &&
      !latest.lifecycle &&
      !latest.deletedAt &&
      !latest.execution.rollover &&
      !latest.execution.requestStateUpdate &&
      !latest.execution.frozenAt
    ) {
      return latest;
    }
    if (
      current.lifecycle?.phase === "deleting" &&
      latest.lifecycle?.phase === "deleted" &&
      latest.lifecycle.operationId === current.lifecycle.operationId
    ) {
      return latest;
    }
    if (
      latest.lifecycle?.operationId !== current.lifecycle?.operationId ||
      latest.lifecycle?.phase !== current.lifecycle?.phase
    ) {
      throw new ExperimentLifecycleError(
        "A different lifecycle intent won the completion race",
        409,
        "experiment-lifecycle-conflict",
        latest.lifecycle,
      );
    }
    return this.repair(current.projectId, current.experimentId);
  }

  private async deleteTargets(
    experiment: ExperimentDocument,
    requestIds: readonly string[],
    reportIds: readonly string[],
  ): Promise<ExperimentLifecycleBlocker[]> {
    const provenance = {
      kind: "experiment" as const,
      experimentId: experiment.experimentId,
      operationId: experiment.lifecycle!.operationId,
    };
    const now = new Date();
    // Revalidate after the execution freeze. Accepted cascades skip their own
    // tombstones; concurrent retries/claims become repairable exact-ID blockers.
    const active = requestIds.length === 0
      ? []
      : await this.collections.requests.find({
          _id: { $in: [...requestIds] },
          projectId: experiment.projectId,
          experimentId: experiment.experimentId,
          deletedAt: { $exists: false },
        } as Document).limit(TARGET_BATCH_SIZE).toArray();
    const vector = active.length === 0
      ? []
      : await this.payloads.readRequests({
          projectId: experiment.projectId,
          experimentId: experiment.experimentId,
          ownerId: experiment.execution.experimentExecutionId,
          generation: experiment.execution.attemptNumber,
        }, experiment.execution.requests);
    const exactRuns = new Map(
      vector.map((member) => [member.requestId, member.runId]),
    );
    const eligible: RequestDocument[] = [];
    const blocking: ExperimentLifecycleBlocker[] = [];
    for (const request of active) {
      if (request.lastDeletionOperationId === provenance.operationId) continue;
      if (exactRuns.get(request._id) !== request.run?._id) {
        blocking.push({
          kind: "request",
          id: request._id,
          reason: "target-conflict",
          error: "Exact run changed after deletion preflight",
        });
        continue;
      }
      try {
        await assertTerminalDeletion([request], this.collections.reports);
        eligible.push(request);
      } catch (error) {
        if (!(error instanceof TerminalDeletionError)) throw error;
        blocking.push(...error.conflicts.map((conflict) => ({
          kind: conflict.reportId ? "report" as const : "request" as const,
          id: conflict.reportId ?? request._id,
          reason: "target-conflict" as const,
          error: `${conflict.handlerId ?? conflict.runId ?? request._id}: ${conflict.reason}`,
        })));
      }
    }
    const pendingReports = reportIds.length === 0 ? [] : await this.collections.reports.find({
      _id: { $in: [...reportIds] },
      projectId: experiment.projectId,
      deletedAt: { $exists: false },
      status: { $nin: ["pending", "generating"] },
    } as Document).limit(TARGET_BATCH_SIZE).toArray();
    // A delayed repair must not tombstone children after another repair has
    // completed this delete and restored them. Per-child operation fences also
    // cover completion between this root check and the guarded child writes.
    const intent = await this.collections.experiments.findOne({
      _id: experiment.experimentId,
      projectId: experiment.projectId,
      "lifecycle.operationId": provenance.operationId,
      "lifecycle.phase": "deleting",
    } as Document);
    if (!intent) {
      throw new ExperimentLifecycleError(
        "Deletion intent changed before child writes",
        409,
        "experiment-lifecycle-conflict",
      );
    }
    for (const requests of batches(eligible)) {
      await this.collections.requests.updateMany(
        {
          $or: requests.map((request) => ({
            ...terminalDeletionFilter(request),
            lastDeletionOperationId: request.lastDeletionOperationId ?? { $exists: false },
          })),
          experimentId: experiment.experimentId,
        } as Document,
        { $set: {
          deletedAt: now,
          deletionProvenance: provenance,
          lastDeletionOperationId: provenance.operationId,
        } } as Document,
      );
    }
    for (const reports of batches(pendingReports.filter((report) =>
      report.lastDeletionOperationId !== provenance.operationId,
    ))) {
      await this.collections.reports.updateMany(
        {
          $or: reports.map((report) => ({
            _id: report._id,
            lastDeletionOperationId: report.lastDeletionOperationId ?? { $exists: false },
          })),
          projectId: experiment.projectId,
          deletedAt: { $exists: false },
          status: { $nin: ["pending", "generating"] },
        } as Document,
        { $set: {
          deletedAt: now,
          deletionProvenance: provenance,
          lastDeletionOperationId: provenance.operationId,
        } } as Document,
      );
    }
    return blocking;
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
    const requestTargets = requestIds.length === 0 ? [] : await this.collections.requests.find({
      _id: { $in: [...requestIds] },
      projectId: experiment.projectId,
      deletionProvenance: filter,
    } as Document).limit(TARGET_BATCH_SIZE).toArray();
    for (const ids of batches(requestTargets.map((request) => request._id))) {
      await this.collections.requests.updateMany(
        {
          _id: { $in: ids },
          projectId: experiment.projectId,
          deletionProvenance: filter,
        } as Document,
        { $unset: { deletedAt: "", deletionProvenance: "" } } as Document,
      );
    }
    const reportTargets = reportIds.length === 0 ? [] : await this.collections.reports.find({
      _id: { $in: [...reportIds] },
      projectId: experiment.projectId,
      deletionProvenance: filter,
    } as Document).limit(TARGET_BATCH_SIZE).toArray();
    for (const ids of batches(reportTargets.map((report) => report._id))) {
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
    blocking: ExperimentLifecycleBlocker[] = [],
  ): Promise<ExperimentDocument> {
    const state = await this.targetState(current, requestIds, reportIds, false);
    state.blocking.push(...blocking);
    // Cross-document publication is not a transaction. A report published
    // after preflight must be surfaced, never silently excluded from the cascade.
    const unexpectedReports = await this.collections.reports.find({
      projectId: current.projectId,
      deletedAt: { $exists: false },
      $or: [
        { experimentId: current.experimentId },
        ...(requestIds.length > 0 ? [{ requestId: { $in: [...requestIds] } }] : []),
      ],
    } as Document).toArray();
    for (const report of unexpectedReports) {
      state.blocking.push({
        kind: "report",
        id: report._id,
        reason: "target-conflict",
        error: "Report remains active after deletion preflight",
      });
    }
    state.blocking = state.blocking.slice(0, 32);
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
        "execution.experimentExecutionId": current.execution.experimentExecutionId,
        "execution.version": current.execution.version,
        "execution.rollover": { $exists: false },
        "execution.requestStateUpdate": { $exists: false },
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
    if (!updated) return this.resume(current);
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
      return updated ?? this.resume(current);
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
    const vectorIds = requestVector.map((member) => member.requestId);
    const requestDocs = vectorIds.length === 0
      ? []
      : await this.collections.requests
        .find({
          _id: { $in: vectorIds },
          projectId: current.projectId,
          experimentId: current.experimentId,
        } as Document)
        .toArray();
    const currentById = new Map(requestDocs.map((request) => [request._id, request]));
    const drifted = requestVector.some(
      (request) => currentById.get(request.requestId)?.run?._id !== request.runId,
    );
    if (drifted) {
      const blocker: ExperimentLifecycleBlocker = {
        kind: "experiment",
        id: current.experimentId,
        reason: "reconciliation-failed",
        error: "Exact request/run vector changed; restoration never creates an execution attempt",
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
      return updated ?? this.resume(current);
    }

    const now = new Date();
    const updated = await this.collections.experiments.findOneAndUpdate(
      {
        _id: current.experimentId,
        projectId: current.projectId,
        stateVersion: current.stateVersion,
        "execution.experimentExecutionId": current.execution.experimentExecutionId,
        "execution.version": current.execution.version,
        "execution.rollover": { $exists: false },
        "execution.requestStateUpdate": { $exists: false },
        "lifecycle.operationId": current.lifecycle!.operationId,
        "lifecycle.phase": "restoring",
        "lifecycle.stateVersion": current.lifecycle!.stateVersion,
      } as Document,
      {
        $set: {
          "execution.updatedAt": now,
          updatedAt: now,
        },
        $unset: {
          deletedAt: "",
          lifecycle: "",
          "execution.frozenAt": "",
        },
        $inc: {
          stateVersion: 1,
          "execution.version": 1,
        },
      } as Document,
      { returnDocument: "after" },
    );
    if (!updated) return this.resume(current);
    return updated;
  }
}
