// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash, randomUUID } from "node:crypto";
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
  type ExperimentTemplateReportSummary,
  type HandlerRunStatus,
  type HandlerServiceDocument,
  type ReportDocument,
  type ReportTemplateDocument,
  type ReportTemplateVersionDocument,
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
  reportTemplates?: Collection<ReportTemplateDocument>;
  reportTemplateVersions?: Collection<ReportTemplateVersionDocument>;
  reports?: Collection<ReportDocument>;
}

export interface ExperimentDispatchMessage
  extends ExperimentQueueMessagePayload {
  projectId: string;
  handlerId: string;
  handlerVersion: number;
  claimToken: string;
  executionVersion: number;
}

export interface ExperimentTemplateDispatchMessage {
  type: "experiment-report";
  projectId: string;
  experimentId: string;
  experimentExecutionId: string;
  templateId: string;
  templateVersionId: string;
  claimToken: string;
  executionVersion: number;
  reportId: string;
}

export type EnqueueExperiment = (
  service: ExperimentHandlerServiceDocument,
  message: ExperimentDispatchMessage | ExperimentTemplateDispatchMessage,
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

function initialExperimentReportId(input: {
  experimentExecutionId: string;
  templateId: string;
  templateVersionId: string;
}): string {
  return `experiment-report-${createHash("sha256")
    .update(
      JSON.stringify([
        input.experimentExecutionId,
        input.templateId,
        input.templateVersionId,
      ]),
    )
    .digest("base64url")}`;
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

      const handlerDispatch = await this.dispatchReadyHandlers(
        experiment,
        projected,
      );
      let latest =
        (await this.store.get(projectId, experimentId)) ?? experiment;
      const templateDispatch = await this.dispatchReadyReportTemplates(
        latest,
        projected,
        byId,
      );
      latest = (await this.store.get(projectId, experimentId)) ?? latest;
      return {
        experiment: latest,
        readiness: currentReadiness(latest),
        rolled,
        dispatched: handlerDispatch || templateDispatch,
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
      .filter(
        (handler) =>
          handler.selector === "taxonomy" ||
          handler.selector === "observations",
      )
      .map((handler) => handler._id);
    const effectiveDependencyIds =
      dependencyIds.length > 0 ? dependencyIds : ["pp-taxonomy"];
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

  private async dispatchReadyReportTemplates(
    experiment: ExperimentDocument,
    requests: readonly ExperimentRequestState[],
    requestById: ReadonlyMap<string, RequestDocument>,
  ): Promise<boolean> {
    if (
      !this.enqueue ||
      !this.collections.reportTemplates ||
      !this.collections.reportTemplateVersions ||
      !this.collections.reports ||
      experiment.execution.handlerSummary["pp-readout"]?.status !== "done" ||
      !experiment.execution.report
    ) {
      return false;
    }
    const services = await this.loadExperimentHandlers();
    const readoutService = services.find((service) => service._id === "pp-readout");
    if (!readoutService) return false;

    const selectedIds = experiment.revision.reportTemplateIds;
    const activeAutomatic = await this.collections.reportTemplates
      .find({
        projectId: experiment.projectId,
        subject: "experiment",
        enabled: true,
        deletedAt: { $exists: false },
        "trigger.type": { $in: ["always", "run-report-templates"] },
      } as Document)
      .toArray();
    const selected = selectedIds.length > 0
      ? await this.collections.reportTemplates
        .find({
          projectId: experiment.projectId,
          id: { $in: selectedIds },
        } as Document)
        .toArray()
      : [];
    const candidates = new Map(
      [...activeAutomatic, ...selected].map((template) => [template.id, template]),
    );
    const summaries = { ...experiment.execution.reportTemplates };
    const newlyQueued = new Set<string>();
    const now = new Date();

    for (const templateId of selectedIds) {
      if (candidates.has(templateId)) continue;
      summaries[templateId] = {
        templateId,
        source: "selected",
        status: "unavailable",
        matchingRunCount: 0,
        blockers: [{ reason: "template-unavailable" }],
        updatedAt: now,
      };
    }

    for (const template of [...candidates.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    )) {
      const source = template.trigger?.type === "always"
        ? "always"
        : template.trigger?.type === "run-report-templates"
          ? "linked"
          : "selected";
      const existing = summaries[template.id];
      if (
        existing &&
        existing.status !== "waiting" &&
        !(existing.status === "failed" && existing.blockers.length > 0)
      ) {
        continue;
      }
      const selectable =
        template.subject === "experiment" &&
        template.enabled &&
        !template.deletedAt &&
        (source !== "selected" || !template.trigger);
      if (!selectable) {
        summaries[template.id] = {
          templateId: template.id,
          templateVersionId: template.currentVersionId,
          templateVersion: template.currentVersion,
          templateContentFingerprint: template.contentFingerprint,
          source,
          status: "unavailable",
          matchingRunCount: 0,
          blockers: [{ reason: "template-unavailable" }],
          updatedAt: now,
        };
        continue;
      }

      const blockers: ExperimentTemplateReportSummary["blockers"] = [];
      let matchingRunCount = 0;
      if (template.trigger?.type === "run-report-templates") {
        for (const runTemplateId of template.trigger.reportTemplateIds) {
          const matching = requests.filter((request) =>
            requestById
              .get(request.requestId)
              ?.run?.reportTemplateIds?.includes(runTemplateId)
          );
          if (matching.length === 0) {
            blockers.push({
              runTemplateId,
              reason: "run-template-unused",
            });
            continue;
          }
          matchingRunCount += matching.length;
          for (const request of matching) {
            const report = await this.collections.reports.findOne(
              {
                projectId: experiment.projectId,
                requestId: request.requestId,
                runId: request.runId,
                templateId: runTemplateId,
              } as Document,
              { sort: { reportVersion: -1, createdAt: -1 } },
            );
            if (!report || report.status === "pending" || report.status === "generating") {
              blockers.push({
                requestId: request.requestId,
                runId: request.runId,
                runTemplateId,
                reason: "run-report-pending",
              });
            } else if (report.status === "failed") {
              blockers.push({
                requestId: request.requestId,
                runId: request.runId,
                runTemplateId,
                reason: "run-report-failed",
                ...(report.error ? { error: report.error } : {}),
              });
            }
          }
        }
      }
      const unused = blockers.some(
        (blocker) => blocker.reason === "run-template-unused",
      );
      const failed = blockers.some(
        (blocker) => blocker.reason === "run-report-failed",
      );
      const waiting = blockers.some(
        (blocker) => blocker.reason === "run-report-pending",
      );
      if (unused || failed || waiting) {
        summaries[template.id] = {
          templateId: template.id,
          templateVersionId: template.currentVersionId,
          templateVersion: template.currentVersion,
          templateContentFingerprint: template.contentFingerprint,
          source,
          status: unused
            ? "not-applicable"
            : failed
              ? "failed"
              : "waiting",
          matchingRunCount,
          blockers,
          updatedAt: now,
        };
        continue;
      }

      const reportId = initialExperimentReportId({
        experimentExecutionId:
          experiment.execution.experimentExecutionId,
        templateId: template.id,
        templateVersionId: template.currentVersionId,
      });
      const claimToken = randomUUID();
      const report: ReportDocument = {
        _id: reportId,
        projectId: experiment.projectId,
        experimentId: experiment.experimentId,
        experimentExecutionId:
          experiment.execution.experimentExecutionId,
        templateId: template.id,
        templateVersionId: template.currentVersionId,
        templateVersion: template.currentVersion,
        templateContentFingerprint: template.contentFingerprint,
        reportVersion: 1,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      try {
        await this.collections.reports.insertOne(report);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("duplicate")
        ) {
          throw error;
        }
      }
      summaries[template.id] = {
        templateId: template.id,
        templateVersionId: template.currentVersionId,
        templateVersion: template.currentVersion,
        templateContentFingerprint: template.contentFingerprint,
        source,
        status: "queued",
        claimToken,
        matchingRunCount,
        blockers: [],
        report: {
          reportId,
          url: `/api/v1/reports/${reportId}`,
          updatedAt: now,
        },
        updatedAt: now,
      };
      newlyQueued.add(template.id);
    }

    if (
      fingerprintExperimentPayload(summaries) !==
      fingerprintExperimentPayload(experiment.execution.reportTemplates)
    ) {
      const updated = await this.store.updateReportTemplateSummaries({
        projectId: experiment.projectId,
        experimentId: experiment.experimentId,
        experimentExecutionId:
          experiment.execution.experimentExecutionId,
        expectedExecutionVersion: experiment.execution.version,
        summaries,
        now,
      });
      if (!updated) {
        const current = await this.store.getIncludingDeleted(
          experiment.projectId,
          experiment.experimentId,
        );
        if (
          current?.lifecycle?.phase === "deleting" ||
          current?.lifecycle?.phase === "deleted" ||
          current?.lifecycle?.phase === "restoring"
        ) {
          await this.collections.reports.updateMany(
            {
              _id: {
                $in: [...newlyQueued].flatMap((templateId) => {
                  const reportId = summaries[templateId]?.report?.reportId;
                  return reportId ? [reportId] : [];
                }),
              },
              projectId: experiment.projectId,
              experimentId: experiment.experimentId,
              experimentExecutionId:
                experiment.execution.experimentExecutionId,
              status: "pending",
              deletedAt: { $exists: false },
            } as Document,
            {
              $set: {
                deletedAt: new Date(),
              },
            } as Document,
          );
        }
        return false;
      }
      experiment = updated;
    }

    let dispatched = false;
    for (const summary of Object.values(experiment.execution.reportTemplates)) {
      if (
        summary.status !== "queued" ||
        !summary.claimToken ||
        !summary.templateVersionId ||
        !summary.report
      ) {
        continue;
      }
      if (
        !newlyQueued.has(summary.templateId) &&
        Date.now() - summary.updatedAt.getTime() < 30_000
      ) {
        continue;
      }
      await this.enqueue(readoutService, {
        type: "experiment-report",
        projectId: experiment.projectId,
        experimentId: experiment.experimentId,
        experimentExecutionId:
          experiment.execution.experimentExecutionId,
        templateId: summary.templateId,
        templateVersionId: summary.templateVersionId,
        claimToken: summary.claimToken,
        executionVersion: experiment.execution.version,
        reportId: summary.report.reportId,
      });
      dispatched = true;
    }
    return dispatched;
  }
}
