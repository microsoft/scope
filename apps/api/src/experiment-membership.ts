// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection, Document } from "mongodb";
import {
  ExperimentStore,
  FixedPayloadStore,
  fingerprintExperimentPayload,
  type ExperimentDocument,
  type ExperimentExecutionHistoryDocument,
  type ExperimentMetadata,
  type ExperimentRequestState,
  type RequestDocument,
} from "shared";

export class ExperimentMembershipError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    readonly code: string,
    readonly conflicts?: Array<{
      requestId: string;
      experimentId?: string;
    }>,
  ) {
    super(message);
  }
}

export interface ExperimentMembershipCollections {
  requests: Collection<RequestDocument>;
  experiments: Collection<ExperimentDocument>;
  executions: Collection<ExperimentExecutionHistoryDocument>;
  chunks: Collection;
}

export interface ReplaceMembershipResult {
  experiment: ExperimentDocument;
  attachedRequestIds: string[];
  detachedRequestIds: string[];
}

function uniqueCanonicalRequestIds(requestIds: readonly string[]): string[] {
  const canonical = [...requestIds].sort();
  const duplicate = canonical.find(
    (requestId, index) => canonical[index - 1] === requestId,
  );
  if (duplicate) {
    throw new ExperimentMembershipError(
      `Request ${duplicate} was selected more than once`,
      400,
      "duplicate-request-id",
      [{ requestId: duplicate }],
    );
  }
  return canonical;
}

export class ExperimentMembershipCoordinator {
  private readonly store: ExperimentStore;
  private readonly payloads: FixedPayloadStore;

  constructor(private readonly collections: ExperimentMembershipCollections) {
    this.store = new ExperimentStore({
      experiments: collections.experiments,
      executions: collections.executions,
      chunks: collections.chunks,
    });
    this.payloads = new FixedPayloadStore(collections.chunks);
  }

  async createFromExisting(input: {
    projectId: string;
    experimentId: string;
    experimentRevisionId: string;
    experimentExecutionId: string;
    metadata: ExperimentMetadata;
    requestIds: readonly string[];
    now?: Date;
  }): Promise<ReplaceMembershipResult> {
    const requestIds = uniqueCanonicalRequestIds(input.requestIds);
    const documents = await this.loadRequestDocuments(
      input.projectId,
      requestIds,
    );
    const now = input.now ?? new Date();
    const requests = requestIds.map((requestId) => {
      const document = documents.get(requestId)!;
      return {
        requestId,
        runId: document.run!._id,
        dependencies: [],
        blockers: [],
      } satisfies ExperimentRequestState;
    });
    try {
      for (const [index, request] of requests.entries()) {
        const result = await this.collections.requests.updateOne(
          {
            _id: request.requestId,
            projectId: input.projectId,
            "run._id": request.runId,
            deletedAt: { $exists: false },
            experimentId: { $exists: false },
          } as Document,
          {
            $set: {
              experimentId: input.experimentId,
              experimentExpectedRequestCount: requests.length,
              experimentRequestIndex: index,
              experimentInitialRunId: request.runId,
              experimentMembershipOperationId:
                input.experimentRevisionId,
              experimentMembershipRevisionId:
                input.experimentRevisionId,
            },
          } as Document,
        );
        if (result.matchedCount === 0) {
          const conflict = await this.collections.requests.findOne(
            { _id: request.requestId } as Document,
          );
          throw new ExperimentMembershipError(
            `Request ${request.requestId} could not be claimed`,
            409,
            "request-membership-conflict",
            [{
              requestId: request.requestId,
              ...(conflict?.experimentId
                ? { experimentId: conflict.experimentId }
                : {}),
            }],
          );
        }
      }
    } catch (error) {
      await this.releaseUnpublishedClaims({
        projectId: input.projectId,
        experimentId: input.experimentId,
        operationId: input.experimentRevisionId,
      });
      throw error;
    }
    const pending = await this.store.createPending({
      experimentId: input.experimentId,
      projectId: input.projectId,
      metadata: input.metadata,
      revision: {
        experimentRevisionId: input.experimentRevisionId,
        revisionNumber: 1,
        memberCount: requests.length,
        membershipFingerprint:
          fingerprintExperimentPayload(
            requests.map(({ requestId, runId }) => ({
              requestId,
              runId,
            })),
          ),
        definitionFingerprint: fingerprintExperimentPayload({
          metadata: input.metadata,
          requestIds,
        }),
        createdAt: now,
      },
      experimentExecutionId: input.experimentExecutionId,
      requests,
      now,
    });
    const published = await this.store.finalizeCreation({
      projectId: input.projectId,
      experimentId: input.experimentId,
      expectedExperimentExecutionId:
        input.experimentExecutionId,
      expectedStateVersion: pending.stateVersion,
      now,
    });
    if (!published) {
      throw new ExperimentMembershipError(
        "Experiment creation could not be finalized",
        409,
        "membership-publication-contention",
      );
    }
    await this.collections.requests.updateMany(
      {
        _id: { $in: requestIds },
        projectId: input.projectId,
        experimentId: input.experimentId,
        experimentMembershipOperationId:
          input.experimentRevisionId,
      } as Document,
      {
        $set: { experimentFinalizedAt: now },
        $unset: { experimentMembershipOperationId: "" },
      } as Document,
    );
    return {
      experiment: published,
      attachedRequestIds: requestIds,
      detachedRequestIds: [],
    };
  }

  async replace(input: {
    projectId: string;
    experimentId: string;
    expectedExperimentRevisionId: string;
    requestIds: readonly string[];
  }, allowReplan = true): Promise<ReplaceMembershipResult> {
    const requestIds = uniqueCanonicalRequestIds(input.requestIds);
    const current = await this.store.get(input.projectId, input.experimentId);
    if (!current) {
      throw new ExperimentMembershipError(
        `Experiment ${input.experimentId} was not found`,
        404,
        "experiment-not-found",
      );
    }
    if (
      current.revision.experimentRevisionId !==
      input.expectedExperimentRevisionId
    ) {
      const publishedRequests =
        (await this.store.readExecutionRequests({
          projectId: input.projectId,
          experimentId: input.experimentId,
          experimentExecutionId:
            current.execution.experimentExecutionId,
        })) ?? [];
      const publishedIds = publishedRequests
        .map(({ requestId }) => requestId)
        .sort();
      const replayFingerprint = fingerprintExperimentPayload({
        experimentId: input.experimentId,
        expectedExperimentRevisionId: input.expectedExperimentRevisionId,
        requestIds,
        runIds: publishedRequests
          .map(({ requestId, runId }) => ({ requestId, runId }))
          .sort((left, right) => left.requestId.localeCompare(right.requestId)),
      });
      if (
        publishedIds.length === requestIds.length &&
        publishedIds.every(
          (requestId, index) => requestId === requestIds[index],
        ) &&
        current.revision.experimentRevisionId ===
          `er_v1_${replayFingerprint}`
      ) {
        return {
          experiment: current,
          attachedRequestIds: [],
          detachedRequestIds: [],
        };
      }
      throw new ExperimentMembershipError(
        `Experiment revision is stale; current revision is ${current.revision.experimentRevisionId}`,
        409,
        "stale-experiment-revision",
      );
    }

    const currentRequests =
      (await this.store.readExecutionRequests({
        projectId: input.projectId,
        experimentId: input.experimentId,
        experimentExecutionId:
          current.execution.experimentExecutionId,
      })) ?? [];
    const currentById = new Map(
      currentRequests.map((request) => [request.requestId, request]),
    );
    const documents = await this.loadRequestDocuments(
      input.projectId,
      requestIds,
      input.experimentId,
    );
    const nextRequests = requestIds.map((requestId) => {
      const document = documents.get(requestId)!;
      const previous = currentById.get(requestId);
      if (previous?.runId === document.run!._id) return previous;
      return {
        requestId,
        runId: document.run!._id,
        dependencies: [],
        blockers: [],
      } satisfies ExperimentRequestState;
    });
    const nextFingerprint = fingerprintExperimentPayload({
      experimentId: input.experimentId,
      expectedExperimentRevisionId: input.expectedExperimentRevisionId,
      requestIds,
      runIds: nextRequests.map(({ requestId, runId }) => ({
        requestId,
        runId,
      })),
    });
    const nextExperimentRevisionId = `er_v1_${nextFingerprint}`;
    const nextExperimentExecutionId = `ee_v1_${nextFingerprint}`;
    const claimed = await this.store.replaceMembership({
      projectId: input.projectId,
      experimentId: input.experimentId,
      expectedExperimentRevisionId:
        input.expectedExperimentRevisionId,
      expectedRevisionNumber: current.revision.revisionNumber,
      expectedExperimentExecutionId:
        current.execution.experimentExecutionId,
      expectedExecutionVersion: current.execution.version,
      nextExperimentRevisionId,
      nextExperimentExecutionId,
      requests: nextRequests,
      deferPublication: true,
    });
    if (!claimed) {
      const latest = await this.store.get(
        input.projectId,
        input.experimentId,
      );
      throw new ExperimentMembershipError(
        `Experiment revision changed during membership replacement`,
        409,
        "membership-contention",
        latest
          ? [{
              requestId: input.experimentId,
              experimentId: latest.revision.experimentRevisionId,
            }]
          : undefined,
      );
    }
    return this.repair(
      input.projectId,
      input.experimentId,
      allowReplan,
    );
  }

  async add(input: {
    projectId: string;
    experimentId: string;
    expectedExperimentRevisionId: string;
    requestIds: readonly string[];
  }): Promise<ReplaceMembershipResult> {
    const selected = uniqueCanonicalRequestIds(input.requestIds);
    const current = await this.currentMembership(input);
    const currentIds = new Set(current.requestIds);
    const conflicts = selected
      .filter((requestId) => currentIds.has(requestId))
      .map((requestId) => ({
        requestId,
        experimentId: input.experimentId,
      }));
    if (conflicts.length > 0) {
      throw new ExperimentMembershipError(
        "One or more requests are already members of the target Experiment",
        409,
        "request-selection-conflict",
        conflicts,
      );
    }
    return this.replace({
      ...input,
      requestIds: [...current.requestIds, ...selected],
    });
  }

  async remove(input: {
    projectId: string;
    experimentId: string;
    expectedExperimentRevisionId: string;
    requestIds: readonly string[];
  }): Promise<ReplaceMembershipResult> {
    const selected = uniqueCanonicalRequestIds(input.requestIds);
    const current = await this.currentMembership(input);
    const selectedIds = new Set(selected);
    const currentIds = new Set(current.requestIds);
    const conflicts = selected
      .filter((requestId) => !currentIds.has(requestId))
      .map((requestId) => ({ requestId }));
    if (conflicts.length > 0) {
      throw new ExperimentMembershipError(
        "One or more requests are not current members of the target Experiment",
        409,
        "request-selection-conflict",
        conflicts,
      );
    }
    return this.replace({
      ...input,
      requestIds: current.requestIds.filter(
        (requestId) => !selectedIds.has(requestId),
      ),
    });
  }

  async repair(
    projectId: string,
    experimentId: string,
    allowReplan = true,
  ): Promise<ReplaceMembershipResult> {
    const experiment = await this.store.get(projectId, experimentId);
    const claim = experiment?.execution.rollover;
    if (!experiment || claim?.reason !== "membership" || !claim.nextRevision) {
      if (!experiment) {
        throw new ExperimentMembershipError(
          `Experiment ${experimentId} was not found`,
          404,
          "experiment-not-found",
        );
      }
      return {
        experiment,
        attachedRequestIds: [],
        detachedRequestIds: [],
      };
    }
    const nextRequests = await this.payloads.readRequests(
      {
        projectId,
        experimentId,
        ownerId: claim.nextExecution.experimentExecutionId,
        generation: claim.nextExecution.attemptNumber,
      },
      claim.nextExecution.requests,
    );
    const currentRequests =
      (await this.store.readExecutionRequests({
        projectId,
        experimentId,
        experimentExecutionId:
          experiment.execution.experimentExecutionId,
      })) ?? [];
    const currentIds = new Set(
      currentRequests.map(({ requestId }) => requestId),
    );
    const nextIds = new Set(nextRequests.map(({ requestId }) => requestId));
    const attachedRequestIds = [...nextIds].filter(
      (requestId) => !currentIds.has(requestId),
    );
    const detachedRequestIds = [...currentIds].filter(
      (requestId) => !nextIds.has(requestId),
    );
    const operationId = claim.nextRevision.experimentRevisionId;

    try {
      for (const request of nextRequests) {
        if (currentIds.has(request.requestId)) continue;
        const result = await this.collections.requests.updateOne(
          {
            _id: request.requestId,
            projectId,
            "run._id": request.runId,
            deletedAt: { $exists: false },
            $or: [
              { experimentId: { $exists: false } },
              {
                experimentId,
                experimentMembershipOperationId: operationId,
              },
            ],
          } as Document,
          {
            $set: {
              experimentId,
              experimentMembershipOperationId: operationId,
            },
          } as Document,
        );
        if (result.matchedCount === 0) {
          const conflict = await this.collections.requests.findOne(
            { _id: request.requestId } as Document,
          );
          throw new ExperimentMembershipError(
            `Request ${request.requestId} could not be claimed`,
            409,
            "request-membership-conflict",
            [{
              requestId: request.requestId,
              ...(conflict?.experimentId
                ? { experimentId: conflict.experimentId }
                : {}),
            }],
          );
        }
      }
    } catch (error) {
      await this.releaseUnpublishedClaims({
        projectId,
        experimentId,
        operationId,
      });
      const aborted = await this.store.abortMembershipReplacement({
        projectId,
        experimentId,
        expectedExperimentExecutionId:
          experiment.execution.experimentExecutionId,
        nextExperimentExecutionId:
          claim.nextExecution.experimentExecutionId,
        nextExperimentRevisionId: operationId,
      });
      if (
        allowReplan &&
        aborted &&
        error instanceof ExperimentMembershipError &&
        error.code === "request-membership-conflict" &&
        error.conflicts?.every((conflict) => !conflict.experimentId)
      ) {
        return this.replace(
          {
            projectId,
            experimentId,
            expectedExperimentRevisionId:
              aborted.revision.experimentRevisionId,
            requestIds: [...nextIds],
          },
          false,
        );
      }
      throw error;
    }

    const published = await this.store.repairRollover(
      projectId,
      experimentId,
    );
    if (
      !published ||
      published.revision.experimentRevisionId !== operationId
    ) {
      throw new ExperimentMembershipError(
        `Experiment membership revision ${operationId} could not be published`,
        409,
        "membership-publication-contention",
      );
    }
    if (detachedRequestIds.length > 0) {
      await this.collections.requests.updateMany(
        {
          _id: { $in: detachedRequestIds },
          projectId,
          experimentId,
        } as Document,
        {
          $unset: {
            experimentId: "",
            experimentMembershipOperationId: "",
            experimentMembershipRevisionId: "",
            experimentFinalizedAt: "",
          },
        } as Document,
      );
    }
    if (nextRequests.length > 0) {
      await this.collections.requests.updateMany(
        {
          _id: { $in: nextRequests.map(({ requestId }) => requestId) },
          projectId,
          experimentId,
        } as Document,
        {
          $set: {
            experimentFinalizedAt: new Date(),
            experimentMembershipRevisionId: operationId,
          },
          $unset: { experimentMembershipOperationId: "" },
        } as Document,
      );
    }
    return { experiment: published, attachedRequestIds, detachedRequestIds };
  }

  private async releaseUnpublishedClaims(input: {
    projectId: string;
    experimentId: string;
    operationId: string;
  }): Promise<void> {
    await this.collections.requests.updateMany(
      {
        projectId: input.projectId,
        experimentId: input.experimentId,
        experimentMembershipOperationId: input.operationId,
      } as Document,
      {
        $unset: {
          experimentId: "",
          experimentMembershipOperationId: "",
          experimentMembershipRevisionId: "",
          experimentExpectedRequestCount: "",
          experimentRequestIndex: "",
          experimentInitialRunId: "",
          experimentFinalizedAt: "",
        },
      } as Document,
    );
  }

  private async loadRequestDocuments(
    projectId: string,
    requestIds: readonly string[],
    allowedExperimentId?: string,
  ): Promise<Map<string, RequestDocument>> {
    const documents = await this.collections.requests
      .find({
        _id: { $in: [...requestIds] },
        deletedAt: { $exists: false },
      } as Document)
      .toArray();
    const byId = new Map(documents.map((document) => [document._id, document]));
    const conflicts: Array<{ requestId: string; experimentId?: string }> = [];
    for (const requestId of requestIds) {
      const document = byId.get(requestId);
      if (!document || document.projectId !== projectId || !document.run) {
        conflicts.push({ requestId });
        continue;
      }
      if (
        document.experimentId &&
        document.experimentId !== allowedExperimentId
      ) {
        conflicts.push({
          requestId,
          experimentId: document.experimentId,
        });
      }
    }
    if (conflicts.length > 0) {
      throw new ExperimentMembershipError(
        "One or more requests are missing, cross-project, archived-only, or already assigned",
        409,
        "request-selection-conflict",
        conflicts,
      );
    }
    return byId;
  }

  private async currentMembership(input: {
    projectId: string;
    experimentId: string;
    expectedExperimentRevisionId: string;
  }): Promise<{ requestIds: string[] }> {
    const current = await this.store.get(input.projectId, input.experimentId);
    if (!current) {
      throw new ExperimentMembershipError(
        `Experiment ${input.experimentId} was not found`,
        404,
        "experiment-not-found",
      );
    }
    if (
      current.revision.experimentRevisionId !==
      input.expectedExperimentRevisionId
    ) {
      throw new ExperimentMembershipError(
        `Experiment revision is stale; current revision is ${current.revision.experimentRevisionId}`,
        409,
        "stale-experiment-revision",
      );
    }
    const requests =
      (await this.store.readExecutionRequests({
        projectId: input.projectId,
        experimentId: input.experimentId,
        experimentExecutionId:
          current.execution.experimentExecutionId,
      })) ?? [];
    return {
      requestIds: requests.map(({ requestId }) => requestId),
    };
  }
}
