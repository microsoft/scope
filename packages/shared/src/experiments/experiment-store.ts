// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection, Document } from "mongodb";
import { FixedPayloadStore } from "./fixed-payload-store.js";
import {
  ExperimentDocumentSchema,
  ExperimentExecutionHistoryDocumentSchema,
  ExperimentExecutionSchema,
  ExperimentMetadataSchema,
  ExperimentRequestStateSchema,
  ExperimentRevisionSchema,
} from "./schemas.js";
import {
  fingerprintExperimentPayload,
  fingerprintExperimentRequestVector,
} from "./routing.js";
import {
  EXPERIMENT_STORAGE_PROFILE_VERSION,
  type ExperimentDocument,
  type ExperimentExecution,
  type ExperimentExecutionHistoryDocument,
  type ExperimentHandlerStatus,
  type ExperimentMetadata,
  type ExperimentPage,
  type ExperimentReportReference,
  type ExperimentTemplateReportSummary,
  type ExperimentRequestState,
  type ExperimentRequestStateUpdateResult,
  type ExperimentRevision,
  type FixedPayload,
} from "./types.js";

export interface ExperimentCollections {
  experiments: Collection<ExperimentDocument>;
  executions: Collection<ExperimentExecutionHistoryDocument>;
  chunks: Collection;
}

export interface CreateExperimentInput {
  experimentId: string;
  projectId: string;
  metadata: ExperimentMetadata;
  revision: ExperimentRevision;
  experimentExecutionId: string;
  requests: readonly ExperimentRequestState[];
  handlerSummary?: ExperimentExecution["handlerSummary"];
  blocking?: ExperimentExecution["blocking"];
  now?: Date;
}

export interface RolloverExperimentInput {
  projectId: string;
  experimentId: string;
  expectedExperimentExecutionId: string;
  expectedExecutionVersion: number;
  nextExperimentExecutionId: string;
  requests: readonly ExperimentRequestState[];
  reason: "rollover" | "retry";
  now?: Date;
}

export interface ReplaceExperimentMembershipInput {
  projectId: string;
  experimentId: string;
  expectedExperimentRevisionId: string;
  expectedRevisionNumber: number;
  expectedExperimentExecutionId: string;
  expectedExecutionVersion: number;
  nextExperimentRevisionId: string;
  nextExperimentExecutionId: string;
  requests: readonly ExperimentRequestState[];
  deferPublication?: boolean;
  now?: Date;
}

export interface ReplaceExperimentReportTemplatesInput {
  projectId: string;
  experimentId: string;
  expectedExperimentRevisionId: string;
  expectedRevisionNumber: number;
  expectedExperimentExecutionId: string;
  expectedExecutionVersion: number;
  nextExperimentRevisionId: string;
  nextExperimentExecutionId: string;
  reportTemplateIds: readonly string[];
  reusableTemplateVersionIds?: Readonly<Record<string, string>>;
  now?: Date;
}

function parseExperiment(value: unknown): ExperimentDocument {
  return ExperimentDocumentSchema.parse(value) as ExperimentDocument;
}

function parseExecution(value: unknown): ExperimentExecution {
  return ExperimentExecutionSchema.parse(value) as ExperimentExecution;
}

function parseHistory(value: unknown): ExperimentExecutionHistoryDocument {
  return ExperimentExecutionHistoryDocumentSchema.parse(
    value,
  ) as ExperimentExecutionHistoryDocument;
}

function assertHandlerId(handlerId: string): void {
  if (
    handlerId.length === 0 ||
    handlerId.length > 200 ||
    handlerId.includes(".") ||
    handlerId.startsWith("$")
  ) {
    throw new Error(`Invalid experiment handler id '${handlerId}'`);
  }
}

function comparable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item instanceof Date ? item.toISOString() : item,
  );
}

export class ExperimentStore {
  private readonly payloads: FixedPayloadStore;

  constructor(private readonly collections: ExperimentCollections) {
    this.payloads = new FixedPayloadStore(collections.chunks);
  }

  async createPending(input: CreateExperimentInput): Promise<ExperimentDocument> {
    const now = input.now ?? new Date();
    const metadata = ExperimentMetadataSchema.parse(
      input.metadata,
    ) as ExperimentMetadata;
    const revision = ExperimentRevisionSchema.parse(
      input.revision,
    ) as ExperimentRevision;
    const requests = input.requests.map((request) =>
      ExperimentRequestStateSchema.parse(request),
    ) as ExperimentRequestState[];
    if (revision.memberCount !== requests.length) {
      throw new Error(
        `Revision memberCount ${revision.memberCount} does not match request count ${requests.length}`,
      );
    }

    const identity = {
      projectId: input.projectId,
      experimentId: input.experimentId,
      ownerId: input.experimentExecutionId,
      generation: 1,
    };
    const shell = (payload: FixedPayload<ExperimentRequestState>): object => ({
      _id: input.experimentId,
      experimentId: input.experimentId,
      projectId: input.projectId,
      metadata,
      storageProfileVersion: EXPERIMENT_STORAGE_PROFILE_VERSION,
      stateVersion: 1,
      revision,
      execution: {
        experimentExecutionId: input.experimentExecutionId,
        attemptNumber: 1,
        version: 1,
        requests: payload,
        vectorFingerprint: fingerprintExperimentRequestVector(requests),
        ...(revision.taxonomy ? { taxonomy: revision.taxonomy } : {}),
        handlerSummary: input.handlerSummary ?? {},
        blocking: input.blocking ?? [],
        createdAt: now,
        updatedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    });
    const payload = await this.payloads.prepareRequests({
      identity,
      entries: requests,
      inlineDocument: shell,
      now,
    });
    const document = parseExperiment(shell(payload));
    await this.collections.experiments.updateOne(
      { _id: document._id } as Document,
      { $setOnInsert: document } as Document,
      { upsert: true },
    );
    const raw: unknown = await this.collections.experiments.findOne({
      _id: document._id,
    } as Document);
    if (!raw) {
      throw new Error(`Experiment ${document.experimentId} was not persisted`);
    }
    const persisted = parseExperiment(raw);
    if (
      persisted.projectId !== document.projectId ||
      persisted.execution.experimentExecutionId !==
        document.execution.experimentExecutionId ||
      persisted.execution.vectorFingerprint !==
        document.execution.vectorFingerprint ||
      persisted.revision.experimentRevisionId !==
        document.revision.experimentRevisionId ||
      persisted.revision.revisionNumber !== document.revision.revisionNumber ||
      persisted.revision.membershipFingerprint !==
        document.revision.membershipFingerprint ||
      persisted.revision.definitionFingerprint !==
        document.revision.definitionFingerprint ||
      persisted.storageProfileVersion !== EXPERIMENT_STORAGE_PROFILE_VERSION
    ) {
      throw new Error(
        `Experiment ${document.experimentId} already exists with different immutable identity`,
      );
    }
    return persisted;
  }

  async finalizeCreation(input: {
    projectId: string;
    experimentId: string;
    expectedExperimentExecutionId: string;
    expectedStateVersion: number;
    now?: Date;
  }): Promise<ExperimentDocument | null> {
    const current = await this.getRaw(input.projectId, input.experimentId);
    if (
      !current ||
      current.execution.experimentExecutionId !==
        input.expectedExperimentExecutionId
    ) {
      return null;
    }
    if (current.finalizedAt) return current;
    if (current.stateVersion !== input.expectedStateVersion) return null;
    await this.payloads.verifyCompleteSet(
      this.executionIdentity(current),
      current.execution.requests,
    );
    const now = input.now ?? new Date();
    const updated = await this.collections.experiments.findOneAndUpdate(
      {
        _id: input.experimentId,
        projectId: input.projectId,
        stateVersion: input.expectedStateVersion,
        "execution.experimentExecutionId":
          input.expectedExperimentExecutionId,
        finalizedAt: { $exists: false },
      } as Document,
      {
        $set: { finalizedAt: now, updatedAt: now },
        $inc: { stateVersion: 1 },
      } as Document,
      { returnDocument: "after" },
    );
    if (updated) return parseExperiment(updated);
    const raced = await this.getRaw(input.projectId, input.experimentId);
    return raced?.finalizedAt ? raced : null;
  }

  async get(
    projectId: string,
    experimentId: string,
  ): Promise<ExperimentDocument | null> {
    const raw: unknown = await this.collections.experiments.findOne({
      _id: experimentId,
      projectId,
      finalizedAt: { $exists: true },
      deletedAt: { $exists: false },
      "lifecycle.phase": {
        $nin: ["deleting", "deleted", "restoring"],
      },
    } as Document);
    return raw ? parseExperiment(raw) : null;
  }

  async getIncludingDeleted(
    projectId: string,
    experimentId: string,
  ): Promise<ExperimentDocument | null> {
    const raw: unknown = await this.collections.experiments.findOne({
      _id: experimentId,
      projectId,
      finalizedAt: { $exists: true },
    } as Document);
    return raw ? parseExperiment(raw) : null;
  }

  async listPage(input: {
    projectId: string;
    limit?: number;
    afterExperimentId?: string;
    includeDeleted?: boolean;
  }): Promise<ExperimentPage> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const filter: Document = {
      projectId: input.projectId,
      finalizedAt: { $exists: true },
      ...(input.includeDeleted
        ? {}
        : {
            deletedAt: { $exists: false },
            "lifecycle.phase": {
              $nin: ["deleting", "deleted", "restoring"],
            },
          }),
      ...(input.afterExperimentId
        ? { _id: { $gt: input.afterExperimentId } }
        : {}),
    };
    const raw = await this.collections.experiments
      .find(filter)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .toArray();
    const parsed = raw.map(parseExperiment);
    const hasMore = parsed.length > limit;
    const experiments = parsed.slice(0, limit);
    return {
      experiments,
      ...(hasMore
        ? { nextCursor: experiments.at(-1)?.experimentId }
        : {}),
    };
  }

  async getExecution(input: {
    projectId: string;
    experimentId: string;
    experimentExecutionId: string;
    includeDeleted?: boolean;
  }): Promise<ExperimentExecution | null> {
    const experiment = input.includeDeleted
      ? await this.getIncludingDeleted(input.projectId, input.experimentId)
      : await this.get(input.projectId, input.experimentId);
    if (
      experiment?.execution.experimentExecutionId ===
      input.experimentExecutionId
    ) {
      return experiment.execution;
    }
    const raw: unknown = await this.collections.executions.findOne({
      _id: input.experimentExecutionId,
      projectId: input.projectId,
      experimentId: input.experimentId,
    } as Document);
    return raw ? parseHistory(raw) : null;
  }

  async readExecutionRequests(input: {
    projectId: string;
    experimentId: string;
    experimentExecutionId: string;
    includeDeleted?: boolean;
  }): Promise<ExperimentRequestState[] | null> {
    const experiment = input.includeDeleted
      ? await this.getIncludingDeleted(input.projectId, input.experimentId)
      : await this.get(input.projectId, input.experimentId);
    const execution =
      experiment?.execution.experimentExecutionId ===
      input.experimentExecutionId
        ? experiment.execution
        : await this.getExecution(input);
    if (!execution) return null;
    return this.payloads.readRequests(
      {
        projectId: input.projectId,
        experimentId: input.experimentId,
        ownerId: execution.experimentExecutionId,
        generation: execution.attemptNumber,
      },
      execution.requests,
    );
  }

  async listExecutionHistory(input: {
    projectId: string;
    experimentId: string;
    limit?: number;
  }): Promise<ExperimentExecutionHistoryDocument[]> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const raw = await this.collections.executions
      .find({
        projectId: input.projectId,
        experimentId: input.experimentId,
      } as Document)
      .sort({ attemptNumber: -1 })
      .limit(limit)
      .toArray();
    return raw.map(parseHistory);
  }

  async claimHandler(input: {
    projectId: string;
    experimentId: string;
    experimentExecutionId: string;
    expectedExecutionVersion: number;
    handlerId: string;
    handlerVersion: number;
    claimToken: string;
    now?: Date;
  }): Promise<ExperimentDocument | null> {
    assertHandlerId(input.handlerId);
    const now = input.now ?? new Date();
    const path = `execution.handlerSummary.${input.handlerId}`;
    const updated = await this.collections.experiments.findOneAndUpdate(
      {
        _id: input.experimentId,
        projectId: input.projectId,
        finalizedAt: { $exists: true },
        "execution.experimentExecutionId":
          input.experimentExecutionId,
        "execution.version": input.expectedExecutionVersion,
        "execution.frozenAt": { $exists: false },
        "execution.rollover": { $exists: false },
        "lifecycle.phase": {
          $nin: ["deleting", "deleted", "restoring"],
        },
        [`${path}.status`]: "queued",
        [`${path}.version`]: input.handlerVersion,
        [`${path}.claimToken`]: input.claimToken,
      } as Document,
      {
        $set: {
          [path]: {
            status: "processing",
            version: input.handlerVersion,
            claimToken: input.claimToken,
            updatedAt: now,
          },
          "execution.startedAt": now,
          "execution.updatedAt": now,
          updatedAt: now,
        },
        $inc: { "execution.version": 1, stateVersion: 1 },
      } as Document,
      { returnDocument: "after" },
    );
    return updated ? parseExperiment(updated) : null;
  }

  async completeHandler(input: {
    projectId: string;
    experimentId: string;
    experimentExecutionId: string;
    expectedExecutionVersion: number;
    handlerId: string;
    handlerVersion: number;
    claimToken: string;
    status: Extract<ExperimentHandlerStatus, "done" | "failed">;
    error?: string;
    report?: ExperimentReportReference;
    now?: Date;
  }): Promise<ExperimentDocument | null> {
    assertHandlerId(input.handlerId);
    const now = input.now ?? new Date();
    const path = `execution.handlerSummary.${input.handlerId}`;
    const updated = await this.collections.experiments.findOneAndUpdate(
      {
        _id: input.experimentId,
        projectId: input.projectId,
        "execution.experimentExecutionId":
          input.experimentExecutionId,
        "execution.version": input.expectedExecutionVersion,
        "execution.rollover": { $exists: false },
        "execution.frozenAt": { $exists: false },
        "lifecycle.phase": {
          $nin: ["deleting", "deleted", "restoring"],
        },
        [`${path}.status`]: "processing",
        [`${path}.version`]: input.handlerVersion,
        [`${path}.claimToken`]: input.claimToken,
      } as Document,
      {
        $set: {
          [path]: {
            status: input.status,
            version: input.handlerVersion,
            claimToken: input.claimToken,
            updatedAt: now,
            ...(input.error ? { error: input.error } : {}),
          },
          "execution.updatedAt": now,
          "execution.finishedAt": now,
          ...(input.report ? { "execution.report": input.report } : {}),
          updatedAt: now,
        },
        $inc: { "execution.version": 1, stateVersion: 1 },
      } as Document,
      { returnDocument: "after" },
    );
    return updated ? parseExperiment(updated) : null;
  }

  async updateReportTemplateSummaries(input: {
    projectId: string;
    experimentId: string;
    experimentExecutionId: string;
    expectedExecutionVersion: number;
    summaries: Record<string, ExperimentTemplateReportSummary>;
    now?: Date;
  }): Promise<ExperimentDocument | null> {
    const now = input.now ?? new Date();
    const updated = await this.collections.experiments.findOneAndUpdate(
      {
        _id: input.experimentId,
        projectId: input.projectId,
        "execution.experimentExecutionId": input.experimentExecutionId,
        "execution.version": input.expectedExecutionVersion,
        "execution.frozenAt": { $exists: false },
        "execution.rollover": { $exists: false },
        "lifecycle.phase": {
          $nin: ["deleting", "deleted", "restoring"],
        },
      } as Document,
      {
        $set: {
          "execution.reportTemplates": input.summaries,
          "execution.updatedAt": now,
          updatedAt: now,
        },
        $inc: { "execution.version": 1, stateVersion: 1 },
      } as Document,
      { returnDocument: "after" },
    );
    return updated ? parseExperiment(updated) : null;
  }

  async claimReportTemplate(input: {
    projectId: string;
    experimentId: string;
    experimentExecutionId: string;
    expectedExecutionVersion: number;
    templateId: string;
    templateVersionId: string;
    claimToken: string;
    now?: Date;
  }): Promise<ExperimentDocument | null> {
    assertHandlerId(input.templateId);
    const now = input.now ?? new Date();
    const path = `execution.reportTemplates.${input.templateId}`;
    const updated = await this.collections.experiments.findOneAndUpdate(
      {
        _id: input.experimentId,
        projectId: input.projectId,
        "execution.experimentExecutionId": input.experimentExecutionId,
        "execution.version": input.expectedExecutionVersion,
        "execution.frozenAt": { $exists: false },
        "execution.rollover": { $exists: false },
        "lifecycle.phase": {
          $nin: ["deleting", "deleted", "restoring"],
        },
        [`${path}.status`]: "queued",
        [`${path}.templateVersionId`]: input.templateVersionId,
        [`${path}.claimToken`]: input.claimToken,
      } as Document,
      {
        $set: {
          [`${path}.status`]: "processing",
          [`${path}.updatedAt`]: now,
          "execution.updatedAt": now,
          updatedAt: now,
        },
        $inc: { "execution.version": 1, stateVersion: 1 },
      } as Document,
      { returnDocument: "after" },
    );
    return updated ? parseExperiment(updated) : null;
  }

  async completeReportTemplate(input: {
    projectId: string;
    experimentId: string;
    experimentExecutionId: string;
    expectedExecutionVersion: number;
    templateId: string;
    templateVersionId: string;
    claimToken: string;
    status: "done" | "failed" | "unavailable";
    report?: ExperimentReportReference;
    error?: string;
    now?: Date;
  }): Promise<ExperimentDocument | null> {
    assertHandlerId(input.templateId);
    const now = input.now ?? new Date();
    const path = `execution.reportTemplates.${input.templateId}`;
    const updated = await this.collections.experiments.findOneAndUpdate(
      {
        _id: input.experimentId,
        projectId: input.projectId,
        "execution.experimentExecutionId": input.experimentExecutionId,
        "execution.version": input.expectedExecutionVersion,
        "execution.frozenAt": { $exists: false },
        "execution.rollover": { $exists: false },
        "lifecycle.phase": {
          $nin: ["deleting", "deleted", "restoring"],
        },
        [`${path}.status`]: "processing",
        [`${path}.templateVersionId`]: input.templateVersionId,
        [`${path}.claimToken`]: input.claimToken,
      } as Document,
      {
        $set: {
          [`${path}.status`]: input.status,
          [`${path}.updatedAt`]: now,
          ...(input.report ? { [`${path}.report`]: input.report } : {}),
          ...(input.error ? { [`${path}.error`]: input.error } : {}),
          "execution.updatedAt": now,
          updatedAt: now,
        },
        $inc: { "execution.version": 1, stateVersion: 1 },
      } as Document,
      { returnDocument: "after" },
    );
    return updated ? parseExperiment(updated) : null;
  }

  async freezeCurrent(input: {
    projectId: string;
    experimentId: string;
    experimentExecutionId: string;
    expectedExecutionVersion: number;
    now?: Date;
  }): Promise<ExperimentDocument | null> {
    const now = input.now ?? new Date();
    const updated = await this.collections.experiments.findOneAndUpdate(
      {
        _id: input.experimentId,
        projectId: input.projectId,
        "execution.experimentExecutionId":
          input.experimentExecutionId,
        "execution.version": input.expectedExecutionVersion,
        "execution.frozenAt": { $exists: false },
        "execution.rollover": { $exists: false },
        "execution.requestStateUpdate": { $exists: false },
        "lifecycle.phase": {
          $nin: ["deleting", "deleted", "restoring"],
        },
      } as Document,
      {
        $set: {
          "execution.frozenAt": now,
          "execution.updatedAt": now,
          updatedAt: now,
        },
        $inc: { "execution.version": 1, stateVersion: 1 },
      } as Document,
      { returnDocument: "after" },
    );
    return updated ? parseExperiment(updated) : null;
  }

  async casUpdateRequestStates(input: {
    projectId: string;
    experimentId: string;
    experimentExecutionId: string;
    expectedExecutionVersion: number;
    updateId: string;
    requests: readonly ExperimentRequestState[];
    now?: Date;
  }): Promise<ExperimentRequestStateUpdateResult> {
    if (input.updateId.trim().length === 0 || input.updateId.length > 200) {
      return {
        status: "invariant",
        message: "Request-state updateId must contain 1-200 characters",
      };
    }
    let requests: ExperimentRequestState[];
    try {
      requests = input.requests.map((request) =>
        ExperimentRequestStateSchema.parse(request),
      ) as ExperimentRequestState[];
    } catch (error) {
      return {
        status: "invariant",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (
      new Set(requests.map((request) => request.requestId)).size !==
      requests.length
    ) {
      return {
        status: "invariant",
        message: "Request-state update contains duplicate request ids",
      };
    }
    const nextPayloadFingerprint = fingerprintExperimentPayload(requests);
    const nextVectorFingerprint =
      fingerprintExperimentRequestVector(requests);
    let experiment = await this.getRaw(input.projectId, input.experimentId);
    if (!experiment) return { status: "stale", reason: "experiment" };
    if (
      experiment.execution.experimentExecutionId !==
      input.experimentExecutionId
    ) {
      return { status: "stale", reason: "execution" };
    }
    if (experiment.execution.frozenAt) {
      return { status: "stale", reason: "frozen" };
    }
    if (
      experiment.execution.vectorFingerprint !== nextVectorFingerprint ||
      experiment.execution.requests.entryCount !== requests.length
    ) {
      return {
        status: "invariant",
        message:
          "Request-state update cannot change the immutable request/run vector",
      };
    }

    const activeClaim = experiment.execution.requestStateUpdate;
    if (activeClaim) {
      if (activeClaim.updateId !== input.updateId) {
        return {
          status: "contention",
          activeUpdateId: activeClaim.updateId,
        };
      }
      if (
        activeClaim.nextPayloadFingerprint !== nextPayloadFingerprint ||
        activeClaim.expectedPayloadFingerprint !==
          experiment.execution.requests.payloadFingerprint
      ) {
        return {
          status: "invariant",
          message: "Retried request-state update does not match its claim",
        };
      }
      if (
        experiment.execution.version !==
        input.expectedExecutionVersion + 1
      ) {
        return { status: "stale", reason: "version" };
      }
    } else {
      if (
        experiment.execution.version !== input.expectedExecutionVersion
      ) {
        return { status: "stale", reason: "version" };
      }
      const claimedAt = input.now ?? new Date();
      let claimed: ExperimentDocument | null;
      try {
        claimed = await this.collections.experiments.findOneAndUpdate(
          {
            _id: input.experimentId,
            projectId: input.projectId,
            "execution.experimentExecutionId":
              input.experimentExecutionId,
            "execution.version": input.expectedExecutionVersion,
            "execution.frozenAt": { $exists: false },
            "execution.rollover": { $exists: false },
            "execution.requestStateUpdate": { $exists: false },
          } as Document,
          {
            $set: {
              "execution.requestStateUpdate": {
                updateId: input.updateId,
                expectedPayloadFingerprint:
                  experiment.execution.requests.payloadFingerprint,
                nextPayloadFingerprint,
                claimedAt,
              },
              "execution.updatedAt": claimedAt,
              updatedAt: claimedAt,
            },
            $inc: { "execution.version": 1, stateVersion: 1 },
          } as Document,
          { returnDocument: "after" },
        );
      } catch (error) {
        return {
          status: "partial-failure",
          updateId: input.updateId,
          updatedChunkIds: [],
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        };
      }
      if (!claimed) {
        const raced = await this.getRaw(
          input.projectId,
          input.experimentId,
        );
        if (raced?.execution.frozenAt) {
          return { status: "stale", reason: "frozen" };
        }
        if (raced?.execution.requestStateUpdate) {
          return {
            status: "contention",
            activeUpdateId:
              raced.execution.requestStateUpdate.updateId,
          };
        }
        return { status: "stale", reason: "version" };
      }
      experiment = parseExperiment(claimed);
    }

    const payloadResult = await this.payloads.casUpdateRequests({
      identity: this.executionIdentity(experiment),
      payload: experiment.execution.requests,
      entries: requests,
      now: input.now,
    });
    if (payloadResult.status !== "applied") {
      if (
        payloadResult.status !== "partial-failure" &&
        payloadResult.updatedChunkIds.length === 0
      ) {
        try {
          await this.abortRequestStateUpdate(experiment, input.updateId);
        } catch (error) {
          return {
            status: "partial-failure",
            updateId: input.updateId,
            updatedChunkIds: [],
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          };
        }
      }
      if (payloadResult.status === "invariant") {
        return {
          status: "invariant",
          message: payloadResult.message,
        };
      }
      if (payloadResult.status === "stale") {
        return { status: "stale", reason: "version" };
      }
      return {
        status: "partial-failure",
        updateId: input.updateId,
        updatedChunkIds: payloadResult.updatedChunkIds,
        message: payloadResult.message,
        retryable: true,
      };
    }

    const now = input.now ?? new Date();
    try {
      const finalized = await this.collections.experiments.findOneAndUpdate(
        {
          _id: input.experimentId,
          projectId: input.projectId,
          "execution.experimentExecutionId":
            input.experimentExecutionId,
          "execution.version": input.expectedExecutionVersion + 1,
          "execution.frozenAt": { $exists: false },
          "execution.requestStateUpdate.updateId": input.updateId,
        } as Document,
        {
          $set: {
            "execution.requests": payloadResult.payload,
            "execution.updatedAt": now,
            updatedAt: now,
          },
          $unset: { "execution.requestStateUpdate": "" },
          $inc: { "execution.version": 1, stateVersion: 1 },
        } as Document,
        { returnDocument: "after" },
      );
      if (!finalized) {
        return {
          status: "partial-failure",
          updateId: input.updateId,
          updatedChunkIds: payloadResult.updatedChunkIds,
          message: "Request-state payload updated but root publication CAS failed",
          retryable: true,
        };
      }
      return {
        status: "applied",
        experiment: parseExperiment(finalized),
        requests,
      };
    } catch (error) {
      return {
        status: "partial-failure",
        updateId: input.updateId,
        updatedChunkIds: payloadResult.updatedChunkIds,
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
  }

  async archiveCurrent(input: {
    projectId: string;
    experimentId: string;
    experimentExecutionId: string;
    now?: Date;
  }): Promise<ExperimentExecutionHistoryDocument | null> {
    const experiment = await this.getRaw(input.projectId, input.experimentId);
    if (
      !experiment ||
      experiment.execution.experimentExecutionId !==
        input.experimentExecutionId ||
      !experiment.execution.frozenAt
    ) {
      return null;
    }
    return this.archive(experiment, input.now ?? new Date());
  }

  async rollover(input: RolloverExperimentInput): Promise<ExperimentDocument | null> {
    const experiment = await this.getRaw(input.projectId, input.experimentId);
    if (
      !experiment ||
      experiment.execution.experimentExecutionId !==
        input.expectedExperimentExecutionId ||
      experiment.execution.version !== input.expectedExecutionVersion ||
      !experiment.execution.frozenAt
    ) {
      return null;
    }
    const now = input.now ?? new Date();
    const requests = input.requests.map((request) =>
      ExperimentRequestStateSchema.parse(request),
    ) as ExperimentRequestState[];
    const generation = experiment.execution.attemptNumber + 1;
    const payload = await this.payloads.prepareRequests({
      identity: {
        projectId: input.projectId,
        experimentId: input.experimentId,
        ownerId: input.nextExperimentExecutionId,
        generation,
      },
      entries: requests,
      inlineDocument: (candidate) => ({
        ...experiment,
        execution: this.nextExecution(
          experiment.execution,
          input.nextExperimentExecutionId,
          candidate,
          requests,
          now,
        ),
      }),
      now,
    });
    const nextExecution = this.nextExecution(
      experiment.execution,
      input.nextExperimentExecutionId,
      payload,
      requests,
      now,
    );
    const claimed = await this.collections.experiments.findOneAndUpdate(
      {
        _id: input.experimentId,
        projectId: input.projectId,
        "execution.experimentExecutionId":
          input.expectedExperimentExecutionId,
        "execution.version": input.expectedExecutionVersion,
        "execution.frozenAt": { $exists: true },
        "execution.rollover": { $exists: false },
      } as Document,
      {
        $set: {
          "execution.rollover": {
            nextExecution,
            reason: input.reason,
            claimedAt: now,
          },
          "execution.updatedAt": now,
          updatedAt: now,
        },
        $inc: { "execution.version": 1, stateVersion: 1 },
      } as Document,
      { returnDocument: "after" },
    );
    if (!claimed) return null;
    return this.repairRollover(input.projectId, input.experimentId);
  }

  async retryCurrent(input: Omit<RolloverExperimentInput, "requests" | "reason">): Promise<ExperimentDocument | null> {
    const experiment = await this.getRaw(input.projectId, input.experimentId);
    if (
      !experiment ||
      experiment.execution.experimentExecutionId !==
        input.expectedExperimentExecutionId
    ) {
      return null;
    }

    const requests = await this.payloads.readRequests(
      this.executionIdentity(experiment),
      experiment.execution.requests,
    );
    return this.rollover({ ...input, requests, reason: "retry" });
  }

  async replaceMembership(
    input: ReplaceExperimentMembershipInput,
  ): Promise<ExperimentDocument | null> {
    const experiment = await this.getRaw(input.projectId, input.experimentId);
    if (!experiment) return null;
    const canonicalRequests = input.requests
      .map((request) => ExperimentRequestStateSchema.parse(request))
      .sort((left, right) =>
        left.requestId.localeCompare(right.requestId),
      ) as ExperimentRequestState[];
    const membershipFingerprint =
      fingerprintExperimentRequestVector(canonicalRequests);
    const nextRevision = ExperimentRevisionSchema.parse({
      experimentRevisionId: input.nextExperimentRevisionId,
      revisionNumber: input.expectedRevisionNumber + 1,
      memberCount: canonicalRequests.length,
      membershipFingerprint,
      reportTemplateIds: experiment.revision.reportTemplateIds,
      definitionFingerprint: fingerprintExperimentPayload({
        metadata: experiment.metadata,
        requestIds: canonicalRequests.map(({ requestId }) => requestId),
        reportTemplateIds: experiment.revision.reportTemplateIds,
        taxonomy: experiment.revision.taxonomy,
      }),
      ...(experiment.revision.taxonomy
        ? { taxonomy: experiment.revision.taxonomy }
        : {}),
      createdAt: input.now ?? new Date(),
    }) as ExperimentRevision;

    const existingClaim = experiment.execution.rollover;
    if (existingClaim?.reason === "membership") {
      if (
        existingClaim.nextRevision?.experimentRevisionId !==
          nextRevision.experimentRevisionId ||
        existingClaim.nextRevision.membershipFingerprint !==
          nextRevision.membershipFingerprint ||
        existingClaim.nextExecution.experimentExecutionId !==
          input.nextExperimentExecutionId
      ) {
        return null;
      }

      return input.deferPublication
        ? experiment
        : this.repairRollover(input.projectId, input.experimentId);
    }
    if (
      experiment.revision.experimentRevisionId !==
        input.expectedExperimentRevisionId ||
      experiment.revision.revisionNumber !== input.expectedRevisionNumber ||
      experiment.execution.experimentExecutionId !==
        input.expectedExperimentExecutionId ||
      experiment.execution.version !== input.expectedExecutionVersion
    ) {
      return null;
    }

    const now = input.now ?? new Date();
    const payload = await this.payloads.prepareRequests({
      identity: {
        projectId: input.projectId,
        experimentId: input.experimentId,
        ownerId: input.nextExperimentExecutionId,
        generation: 1,
      },
      entries: canonicalRequests,
      inlineDocument: (candidate) => ({
        ...experiment,
        revision: nextRevision,
        execution: this.membershipExecution(
          input.nextExperimentExecutionId,
          candidate,
          canonicalRequests,
          now,
          nextRevision.taxonomy,
        ),
      }),
      now,
    });
    const nextExecution = this.membershipExecution(
      input.nextExperimentExecutionId,
      payload,
      canonicalRequests,
      now,
      nextRevision.taxonomy,
    );
    const claimed = await this.collections.experiments.findOneAndUpdate(
      {
        _id: input.experimentId,
        projectId: input.projectId,
        "revision.experimentRevisionId":
          input.expectedExperimentRevisionId,
        "revision.revisionNumber": input.expectedRevisionNumber,
        "execution.experimentExecutionId":
          input.expectedExperimentExecutionId,
        "execution.version": input.expectedExecutionVersion,
        "execution.rollover": { $exists: false },
      } as Document,
      {
        $set: {
          "execution.frozenAt": now,
          "execution.rollover": {
            nextExecution,
            nextRevision,
            reason: "membership",
            claimedAt: now,
          },
          "execution.updatedAt": now,
          updatedAt: now,
        },
        $inc: { "execution.version": 1, stateVersion: 1 },
      } as Document,
      { returnDocument: "after" },
    );
    if (!claimed) {
      await this.payloads.discardUnpublished(payload);
      return null;
    }
    return input.deferPublication
      ? parseExperiment(claimed)
      : this.repairRollover(input.projectId, input.experimentId);
  }

  async replaceReportTemplates(
    input: ReplaceExperimentReportTemplatesInput,
  ): Promise<ExperimentDocument | null> {
    const experiment = await this.getRaw(input.projectId, input.experimentId);
    if (!experiment) return null;
    const reportTemplateIds = [...new Set(input.reportTemplateIds)].sort();
    if (
      comparable(reportTemplateIds) ===
      comparable(experiment.revision.reportTemplateIds)
    ) {
      return experiment;
    }
    if (
      experiment.revision.experimentRevisionId !==
        input.expectedExperimentRevisionId ||
      experiment.revision.revisionNumber !== input.expectedRevisionNumber ||
      experiment.execution.experimentExecutionId !==
        input.expectedExperimentExecutionId ||
      experiment.execution.version !== input.expectedExecutionVersion ||
      experiment.execution.rollover
    ) {
      return null;
    }
    const requests = await this.payloads.readRequests(
      this.executionIdentity(experiment),
      experiment.execution.requests,
    );
    const now = input.now ?? new Date();
    const nextRevision = ExperimentRevisionSchema.parse({
      experimentRevisionId: input.nextExperimentRevisionId,
      revisionNumber: input.expectedRevisionNumber + 1,
      memberCount: experiment.revision.memberCount,
      membershipFingerprint: experiment.revision.membershipFingerprint,
      reportTemplateIds,
      definitionFingerprint: fingerprintExperimentPayload({
        metadata: experiment.metadata,
        requestIds: requests.map(({ requestId }) => requestId).sort(),
        reportTemplateIds,
        taxonomy: experiment.revision.taxonomy,
      }),
      ...(experiment.revision.taxonomy
        ? { taxonomy: experiment.revision.taxonomy }
        : {}),
      createdAt: now,
    }) as ExperimentRevision;
    const reusableHandlerSummary: ExperimentExecution["handlerSummary"] =
      experiment.execution.handlerSummary["pp-readout"]?.status === "done"
        ? {
            "pp-readout": experiment.execution.handlerSummary["pp-readout"],
          }
        : {};
    const reusableReportTemplates = Object.fromEntries(
      Object.entries(experiment.execution.reportTemplates).filter(
        ([templateId, summary]) =>
          summary.status === "done" &&
          summary.templateVersionId !== undefined &&
          input.reusableTemplateVersionIds?.[templateId] ===
            summary.templateVersionId,
      ),
    );
    const buildExecution = (
      payload: FixedPayload<ExperimentRequestState>,
    ): ExperimentExecution => ({
      experimentExecutionId: input.nextExperimentExecutionId,
      attemptNumber: 1,
      version: 1,
      requests: payload,
      vectorFingerprint: experiment.execution.vectorFingerprint,
      ...(experiment.revision.taxonomy
        ? { taxonomy: experiment.revision.taxonomy }
        : {}),
      handlerSummary: reusableHandlerSummary,
      reportTemplates: reusableReportTemplates,
      blocking: [],
      ...(experiment.execution.report
        ? { report: experiment.execution.report }
        : {}),
      createdAt: now,
      updatedAt: now,
    });
    const payload = await this.payloads.prepareRequests({
      identity: {
        projectId: input.projectId,
        experimentId: input.experimentId,
        ownerId: input.nextExperimentExecutionId,
        generation: 1,
      },
      entries: requests,
      inlineDocument: (candidate) => ({
        ...experiment,
        revision: nextRevision,
        execution: buildExecution(candidate),
      }),
      now,
    });
    const nextExecution = buildExecution(payload);
    const claimed = await this.collections.experiments.findOneAndUpdate(
      {
        _id: input.experimentId,
        projectId: input.projectId,
        "revision.experimentRevisionId":
          input.expectedExperimentRevisionId,
        "revision.revisionNumber": input.expectedRevisionNumber,
        "execution.experimentExecutionId":
          input.expectedExperimentExecutionId,
        "execution.version": input.expectedExecutionVersion,
        "execution.rollover": { $exists: false },
      } as Document,
      {
        $set: {
          "execution.frozenAt": now,
          "execution.rollover": {
            nextExecution,
            nextRevision,
            reason: "templates",
            claimedAt: now,
          },
          "execution.updatedAt": now,
          updatedAt: now,
        },
        $inc: { "execution.version": 1, stateVersion: 1 },
      } as Document,
      { returnDocument: "after" },
    );
    if (!claimed) {
      await this.payloads.discardUnpublished(payload);
      return null;
    }
    return this.repairRollover(input.projectId, input.experimentId);
  }

  async abortMembershipReplacement(input: {
    projectId: string;
    experimentId: string;
    expectedExperimentExecutionId: string;
    nextExperimentExecutionId: string;
    nextExperimentRevisionId: string;
    now?: Date;
  }): Promise<ExperimentDocument | null> {
    const experiment = await this.getRaw(input.projectId, input.experimentId);
    const rollover = experiment?.execution.rollover;
    if (
      !experiment ||
      rollover?.reason !== "membership" ||
      rollover.nextRevision?.experimentRevisionId !==
        input.nextExperimentRevisionId ||
      rollover.nextExecution.experimentExecutionId !==
        input.nextExperimentExecutionId ||
      experiment.execution.experimentExecutionId !==
        input.expectedExperimentExecutionId
    ) {
      return null;
    }

    const now = input.now ?? new Date();
    const updated = await this.collections.experiments.findOneAndUpdate(
      {
        _id: input.experimentId,
        projectId: input.projectId,
        "execution.experimentExecutionId":
          input.expectedExperimentExecutionId,
        "execution.rollover.reason": "membership",
        "execution.rollover.nextRevision.experimentRevisionId":
          input.nextExperimentRevisionId,
        "execution.rollover.nextExecution.experimentExecutionId":
          input.nextExperimentExecutionId,
      } as Document,
      {
        $set: {
          "execution.updatedAt": now,
          updatedAt: now,
        },
        $unset: {
          "execution.frozenAt": "",
          "execution.rollover": "",
        },
        $inc: { "execution.version": 1, stateVersion: 1 },
      } as Document,
      { returnDocument: "after" },
    );
    if (!updated) return null;
    await this.payloads.discardUnpublished(
      rollover.nextExecution.requests,
    );
    return parseExperiment(updated);
  }

  async discardStale(input: {
    projectId: string;
    experimentId: string;
    experimentExecutionId: string;
    expectedExecutionVersion: number;
    reason: string;
    now?: Date;
  }): Promise<ExperimentDocument | null> {
    const now = input.now ?? new Date();
    const updated = await this.collections.experiments.findOneAndUpdate(
      {
        _id: input.experimentId,
        projectId: input.projectId,
        "execution.experimentExecutionId":
          input.experimentExecutionId,
        "execution.version": input.expectedExecutionVersion,
        "execution.rollover": { $exists: false },
        "execution.discardedAt": { $exists: false },
      } as Document,
      {
        $set: {
          "execution.discardedAt": now,
          "execution.discardReason": input.reason.slice(0, 2_048),
          "execution.updatedAt": now,
          updatedAt: now,
        },
        $inc: { "execution.version": 1, stateVersion: 1 },
      } as Document,
      { returnDocument: "after" },
    );
    return updated ? parseExperiment(updated) : null;
  }

  async repairRollover(
    projectId: string,
    experimentId: string,
  ): Promise<ExperimentDocument | null> {
    const experiment = await this.getRaw(projectId, experimentId);
    const rollover = experiment?.execution.rollover;
    if (!experiment || !rollover) return experiment;
    const next = parseExecution(rollover.nextExecution);
    const nextRevision = rollover.nextRevision
      ? (ExperimentRevisionSchema.parse(
          rollover.nextRevision,
        ) as ExperimentRevision)
      : undefined;
    await this.payloads.verifyCompleteSet(
      {
        projectId,
        experimentId,
        ownerId: next.experimentExecutionId,
        generation: next.attemptNumber,
      },
      next.requests,
    );
    await this.archive(experiment, rollover.claimedAt);
    const now = new Date();
    const updated = await this.collections.experiments.findOneAndUpdate(
      {
        _id: experimentId,
        projectId,
        "execution.experimentExecutionId":
          experiment.execution.experimentExecutionId,
        "execution.rollover.nextExecution.experimentExecutionId":
          next.experimentExecutionId,
      } as Document,
      {
        $set: {
          execution: next,
          ...(nextRevision ? { revision: nextRevision } : {}),
          updatedAt: now,
        },
        $inc: { stateVersion: 1 },
      } as Document,
      { returnDocument: "after" },
    );
    if (updated) return parseExperiment(updated);
    return this.getRaw(projectId, experimentId);
  }

  private async getRaw(
    projectId: string,
    experimentId: string,
  ): Promise<ExperimentDocument | null> {
    const raw: unknown = await this.collections.experiments.findOne({
      _id: experimentId,
      projectId,
    } as Document);
    return raw ? parseExperiment(raw) : null;
  }

  private executionIdentity(experiment: ExperimentDocument) {
    return {
      projectId: experiment.projectId,
      experimentId: experiment.experimentId,
      ownerId: experiment.execution.experimentExecutionId,
      generation: experiment.execution.attemptNumber,
    };
  }

  private nextExecution(
    current: ExperimentExecution,
    experimentExecutionId: string,
    requests: FixedPayload<ExperimentRequestState>,
    entries: ExperimentRequestState[],
    now: Date,
  ): ExperimentExecution {
    return {
      experimentExecutionId,
      attemptNumber: current.attemptNumber + 1,
      version: 1,
      requests,
      vectorFingerprint: fingerprintExperimentRequestVector(entries),
      ...(current.taxonomy ? { taxonomy: current.taxonomy } : {}),
      handlerSummary: {},
      reportTemplates: {},
      blocking: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private membershipExecution(
    experimentExecutionId: string,
    requests: FixedPayload<ExperimentRequestState>,
    entries: ExperimentRequestState[],
    now: Date,
    taxonomy?: ExperimentRevision["taxonomy"],
  ): ExperimentExecution {
    return {
      experimentExecutionId,
      attemptNumber: 1,
      version: 1,
      requests,
      vectorFingerprint: fingerprintExperimentRequestVector(entries),
      ...(taxonomy ? { taxonomy } : {}),
      handlerSummary: {},
      reportTemplates: {},
      blocking: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async archive(
    experiment: ExperimentDocument,
    archivedAt: Date,
  ): Promise<ExperimentExecutionHistoryDocument> {
    const rollover = experiment.execution.rollover;
    const {
      rollover: _rollover,
      ...execution
    } = experiment.execution;
    const history = parseHistory({
      ...execution,
      _id: execution.experimentExecutionId,
      experimentId: experiment.experimentId,
      projectId: experiment.projectId,
      storageProfileVersion: experiment.storageProfileVersion,
      revision: experiment.revision,
      archivedAt,
      ...(rollover
        ? {
            supersededAt: rollover.claimedAt,
            supersededByExperimentExecutionId:
              rollover.nextExecution.experimentExecutionId,
            supersededReason: rollover.reason,
          }
        : {}),
    });
    await this.collections.executions.updateOne(
      { _id: history._id } as Document,
      { $setOnInsert: history } as Document,
      { upsert: true },
    );
    const raw: unknown = await this.collections.executions.findOne({
      _id: history._id,
    } as Document);
    if (!raw) {
      throw new Error(
        `Experiment execution history ${history._id} was not persisted`,
      );
    }
    const persisted = parseHistory(raw);
    if (comparable(persisted) !== comparable(history)) {
      throw new Error(
        `Experiment execution history ${history._id} is immutable and does not match`,
      );
    }
    return persisted;
  }

  private async abortRequestStateUpdate(
    experiment: ExperimentDocument,
    updateId: string,
  ): Promise<void> {
    await this.collections.experiments.updateOne(
      {
        _id: experiment.experimentId,
        projectId: experiment.projectId,
        "execution.experimentExecutionId":
          experiment.execution.experimentExecutionId,
        "execution.version": experiment.execution.version,
        "execution.requestStateUpdate.updateId": updateId,
      } as Document,
      {
        $unset: { "execution.requestStateUpdate": "" },
        $set: { updatedAt: new Date() },
        $inc: { stateVersion: 1 },
      } as Document,
    );
  }
}
