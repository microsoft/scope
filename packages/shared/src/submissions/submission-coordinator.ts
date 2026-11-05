// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { v5 as uuidv5 } from "uuid";
import type { Collection, Document } from "mongodb";
import type {
  HandlerServiceDocument,
  RequestDocument,
  SubmissionDocument,
  SubmissionHandlerServiceDocument,
  SubmissionQueueMessagePayload,
  SubmissionReportPointer,
  SubmissionRunHistoryDocument,
  SubmissionRunState,
  ServiceHandlerDocument,
} from "../types/types.js";
import {
  OBSERVATIONS_HANDLER_ID,
  READOUT_HANDLER_ID,
  computeSubmissionVectorFingerprint,
  deriveSubmissionReadiness,
  projectSubmissionDependency,
} from "./submission-state.js";

const SUBMISSION_RUN_NAMESPACE = "6b0f8a6a-5cda-4cb4-bcc4-79bb0ac7f54d";

export interface SubmissionCollections {
  requests: Collection<RequestDocument>;
  submissions: Collection<SubmissionDocument>;
  submissionRuns: Collection<SubmissionRunHistoryDocument>;
  services: Collection<ServiceHandlerDocument>;
}

export type EnqueueSubmission = (
  service: SubmissionHandlerServiceDocument,
  message: SubmissionQueueMessagePayload,
) => Promise<void>;

export interface ReconcileSubmissionResult {
  submission: SubmissionDocument;
  readiness: ReturnType<typeof deriveSubmissionReadiness>;
  rolled: boolean;
  dispatched: boolean;
}

function submissionRunId(
  submissionId: string,
  attemptNumber: number,
  vectorFingerprint: string,
): string {
  return uuidv5(
    `${submissionId}:${attemptNumber}:${vectorFingerprint}`,
    SUBMISSION_RUN_NAMESPACE,
  );
}

function initialSubmissionRun(
  submissionId: string,
  requests: Array<{ requestId: string; runId: string }>,
  createdAt: Date,
): SubmissionRunState {
  const vectorFingerprint = computeSubmissionVectorFingerprint(requests);
  return {
    _id: submissionRunId(submissionId, 1, vectorFingerprint),
    attemptNumber: 1,
    vectorFingerprint,
    requests,
    createdAt,
    dependencyProjection: [],
    blocking: [],
  };
}

export async function ensureNativeSubmission(input: {
  collections: Pick<SubmissionCollections, "submissions">;
  submissionId: string;
  projectId: string;
  requests: Array<{ requestId: string; runId: string }>;
  createdAt?: Date;
}): Promise<SubmissionDocument> {
  const requestIds = input.requests.map((request) => request.requestId);
  const createdAt = input.createdAt ?? new Date();
  const doc: SubmissionDocument = {
    _id: input.submissionId,
    submissionId: input.submissionId,
    projectId: input.projectId,
    requestIds,
    createdAt,
    run: initialSubmissionRun(input.submissionId, input.requests, createdAt),
  };
  await input.collections.submissions.updateOne(
    { _id: input.submissionId } as Document,
    { $setOnInsert: doc } as Document,
    { upsert: true },
  );
  const persisted = await input.collections.submissions.findOne({
    _id: input.submissionId,
  } as Document);
  if (!persisted) {
    throw new Error(`Submission ${input.submissionId} was not persisted`);
  }
  const sameProject = persisted.projectId === input.projectId;
  const sameRequests =
    persisted.requestIds.length === requestIds.length &&
    persisted.requestIds.every((requestId, index) => requestId === requestIds[index]);
  const sameInitialVector =
    persisted.run.attemptNumber > 1 ||
    (persisted.run.requests.length === input.requests.length &&
      persisted.run.requests.every((request, index) => {
        const expected = input.requests[index];
        return (
          request.requestId === expected?.requestId &&
          request.runId === expected.runId
        );
      }));
  if (!sameProject || !sameRequests || !sameInitialVector) {
    throw new Error(
      `Submission ${input.submissionId} already exists with a different immutable request vector`,
    );
  }
  return persisted;
}

async function loadPostProcessHandlers(
  services: Collection<ServiceHandlerDocument>,
): Promise<HandlerServiceDocument[]> {
  const documents = await services
    .find({ type: "post-process-handler" })
    .toArray();
  return documents.filter(
    (document): document is HandlerServiceDocument =>
      document.type === "post-process-handler",
  );
}

async function loadReadoutService(
  services: Collection<ServiceHandlerDocument>,
): Promise<SubmissionHandlerServiceDocument | null> {
  const document = await services.findOne({
    _id: READOUT_HANDLER_ID,
    type: "submission-handler",
  });
  return document?.type === "submission-handler" ? document : null;
}

async function archiveAndRoll(input: {
  collections: SubmissionCollections;
  submission: SubmissionDocument;
  requests: Array<{ requestId: string; runId: string }>;
  reason: "request-vector-changed" | "manual-retry";
}): Promise<SubmissionDocument | null> {
  let claimed = input.submission;
  if (!claimed.run.rollover) {
    const claimedAt = new Date();
    const nextAttemptNumber = claimed.run.attemptNumber + 1;
    const vectorFingerprint = computeSubmissionVectorFingerprint(input.requests);
    const nextSubmissionRunId = submissionRunId(
      claimed._id,
      nextAttemptNumber,
      vectorFingerprint,
    );
    const claimedDocument = await input.collections.submissions.findOneAndUpdate(
      {
        _id: claimed._id,
        "run._id": claimed.run._id,
        "run.vectorFingerprint": claimed.run.vectorFingerprint,
        "run.rollover": { $exists: false },
      } as Document,
      {
        $set: {
          "run.rollover": {
            nextSubmissionRunId,
            vectorFingerprint,
            requests: input.requests,
            reason: input.reason,
            claimedAt,
          },
          "run.updatedAt": claimedAt,
          updatedAt: claimedAt,
        },
      } as Document,
      { returnDocument: "after" },
    );
    if (!claimedDocument) return null;
    claimed = claimedDocument;
  }
  const rollover = claimed.run.rollover;
  if (!rollover) return null;
  const { rollover: _rollover, reconcileAfter: _reconcileAfter, ...archivedRun } =
    claimed.run;
  const archived: SubmissionRunHistoryDocument = {
    ...archivedRun,
    submissionId: claimed._id,
    projectId: claimed.projectId,
    supersededAt: rollover.claimedAt,
    supersededBySubmissionRunId: rollover.nextSubmissionRunId,
    supersededReason: rollover.reason,
  };
  await input.collections.submissionRuns.updateOne(
    { _id: archived._id } as Document,
    { $setOnInsert: archived } as Document,
    { upsert: true },
  );

  const nextRun: SubmissionRunState = {
    _id: rollover.nextSubmissionRunId,
    attemptNumber: claimed.run.attemptNumber + 1,
    vectorFingerprint: rollover.vectorFingerprint,
    requests: rollover.requests,
    createdAt: rollover.claimedAt,
    dependencyProjection: [],
    blocking: [],
  };
  const updated = await input.collections.submissions.findOneAndUpdate(
    {
      _id: claimed._id,
      "run._id": claimed.run._id,
      "run.rollover.nextSubmissionRunId": rollover.nextSubmissionRunId,
    } as Document,
    {
      $set: {
        run: nextRun,
        updatedAt: rollover.claimedAt,
      },
    } as Document,
    { returnDocument: "after" },
  );
  return updated;
}

export class SubmissionCoordinator {
  private recoveryAfterRequestId: string | null = null;

  constructor(
    private readonly collections: SubmissionCollections,
    private readonly enqueue?: EnqueueSubmission,
  ) {}

  async recoverMissingNativeSubmissions(limit = 30): Promise<number> {
    const filter: Document = {
      submissionId: { $exists: true },
      submissionExpectedRequestCount: { $exists: true },
      submissionFinalizedAt: { $exists: false },
      deletedAt: { $exists: false },
      ...(this.recoveryAfterRequestId
        ? { _id: { $gt: this.recoveryAfterRequestId } }
        : {}),
    };
    const candidates = await this.collections.requests
      .find(filter)
      .project({
        _id: 1,
        projectId: 1,
        submissionId: 1,
        submissionExpectedRequestCount: 1,
        submissionRequestIndex: 1,
        submissionInitialRunId: 1,
        "run._id": 1,
        createdAt: 1,
      })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
    this.recoveryAfterRequestId =
      candidates.length === limit ? candidates.at(-1)?._id ?? null : null;
    let recovered = 0;
    const visited = new Set<string>();
    for (const candidate of candidates) {
      const submissionId = candidate.submissionId;
      const expected = candidate.submissionExpectedRequestCount;
      if (!submissionId || !expected || visited.has(submissionId)) continue;
      visited.add(submissionId);
      const requests = await this.collections.requests
        .find({
          submissionId,
          projectId: candidate.projectId,
          submissionExpectedRequestCount: expected,
          deletedAt: { $exists: false },
        } as Document)
        .sort({ submissionRequestIndex: 1, _id: 1 })
        .toArray();
      if (
        requests.length !== expected ||
        requests.some(
          (request, index) =>
            request.submissionRequestIndex !== index ||
            !request.submissionInitialRunId,
        )
      ) {
        continue;
      }
      await ensureNativeSubmission({
        collections: this.collections,
        submissionId,
        projectId: candidate.projectId,
        requests: requests.map((request) => ({
          requestId: request._id,
          runId: request.submissionInitialRunId!,
        })),
        createdAt: requests[0]?.createdAt,
      });
      await this.collections.requests.updateMany(
        {
          submissionId,
          projectId: candidate.projectId,
          submissionExpectedRequestCount: expected,
          submissionFinalizedAt: { $exists: false },
        } as Document,
        { $set: { submissionFinalizedAt: new Date() } } as Document,
      );
      recovered++;
    }
    return recovered;
  }

  async reconcile(submissionId: string): Promise<ReconcileSubmissionResult | null> {
    let rolled = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const submission = await this.collections.submissions.findOne({
        _id: submissionId,
      } as Document);
      if (!submission) return null;
      if (
        submission.run.reconcileAfter &&
        submission.run.reconcileAfter.getTime() > Date.now()
      ) {
        return {
          submission,
          readiness: deriveSubmissionReadiness(submission.run),
          rolled,
          dispatched: false,
        };
      }
      if (submission.run.reconcileAfter) {
        await this.collections.submissions.updateOne(
          { _id: submissionId, "run._id": submission.run._id } as Document,
          {
            $unset: { "run.reconcileAfter": "" },
            $set: { updatedAt: new Date() },
          } as Document,
        );
        delete submission.run.reconcileAfter;
      }
      if (submission.run.rollover) {
        const updated = await archiveAndRoll({
          collections: this.collections,
          submission,
          requests: submission.run.rollover.requests,
          reason: submission.run.rollover.reason,
        });
        rolled = true;
        if (!updated) continue;
        continue;
      }

      const requestDocs = await this.collections.requests
        .find({
          _id: { $in: submission.requestIds },
          projectId: submission.projectId,
          deletedAt: { $exists: false },
        } as Document)
        .toArray();
      const byId = new Map(requestDocs.map((request) => [request._id, request]));
      const latestVector = submission.requestIds.flatMap((requestId) => {
        const runId = byId.get(requestId)?.run?._id;
        return runId ? [{ requestId, runId }] : [];
      });
      const latestFingerprint =
        latestVector.length === submission.requestIds.length
          ? computeSubmissionVectorFingerprint(latestVector)
          : submission.run.vectorFingerprint;

      if (
        latestVector.length === submission.requestIds.length &&
        latestFingerprint !== submission.run.vectorFingerprint
      ) {
        const updated = await archiveAndRoll({
          collections: this.collections,
          submission,
          requests: latestVector,
          reason: "request-vector-changed",
        });
        rolled = true;
        if (!updated) continue;
        continue;
      }

      const handlers = await loadPostProcessHandlers(this.collections.services);
      const projected = submission.run.requests.map((ref) =>
        projectSubmissionDependency({
          requestId: ref.requestId,
          expectedRunId: ref.runId,
          run: byId.get(ref.requestId)?.run,
          handlers,
          handlerId: OBSERVATIONS_HANDLER_ID,
        }),
      );
      const dependencyProjection = projected.map((result) => result.projection);
      const blocking = projected.flatMap((result) =>
        result.blocking ? [result.blocking] : [],
      );
      const now = new Date();
      const refreshed = await this.collections.submissions.findOneAndUpdate(
        { _id: submissionId, "run._id": submission.run._id } as Document,
        {
          $set: {
            "run.dependencyProjection": dependencyProjection,
            "run.blocking": blocking,
            "run.updatedAt": now,
            updatedAt: now,
          },
        } as Document,
        { returnDocument: "after" },
      );
      if (!refreshed) continue;

      let dispatched = false;
      const readiness = deriveSubmissionReadiness(refreshed.run);
      if (readiness === "ready" && this.enqueue) {
        const service = await loadReadoutService(this.collections.services);
        const existing = refreshed.run.handlerStatus?.[READOUT_HANDLER_ID];
        const eligible =
          service &&
          (!existing ||
            (service.autoBackfill &&
              existing.status === "done" &&
              (existing.version ?? 0) < service.version));
        if (service && eligible) {
          await this.enqueue(service, {
            type: service.selector,
            submissionId,
            submissionRunId: refreshed.run._id,
          });
          const queuedAt = new Date();
          const marked = await this.collections.submissions.updateOne(
            {
              _id: submissionId,
              "run._id": refreshed.run._id,
              [`run.handlerStatus.${READOUT_HANDLER_ID}.status`]: {
                $nin: ["queued", "processing", "failed"],
              },
            } as Document,
            {
              $set: {
                [`run.handlerStatus.${READOUT_HANDLER_ID}`]: {
                  status: "queued",
                  version: service.version,
                  updatedAt: queuedAt,
                },
                "run.updatedAt": queuedAt,
                updatedAt: queuedAt,
              },
            } as Document,
          );
          dispatched = marked.modifiedCount === 1;
        }
      }
      const finalSubmission = dispatched
        ? await this.collections.submissions.findOne({ _id: submissionId } as Document)
        : refreshed;
      if (!finalSubmission) return null;
      return {
        submission: finalSubmission,
        readiness: deriveSubmissionReadiness(finalSubmission.run),
        rolled,
        dispatched,
      };
    }
    throw new Error(`Submission ${submissionId} could not be reconciled after concurrent updates`);
  }

  async retryCurrent(
    submissionId: string,
    expectedSubmissionRunId: string,
  ): Promise<ReconcileSubmissionResult | null> {
    const reconciled = await this.reconcile(submissionId);
    if (!reconciled) return null;
    if (reconciled.submission.run._id !== expectedSubmissionRunId) {
      return reconciled;
    }
    if (reconciled.readiness === "blocked" || reconciled.readiness === "waiting") {
      return reconciled;
    }
    const rolled = await archiveAndRoll({
      collections: this.collections,
      submission: reconciled.submission,
      requests: reconciled.submission.run.requests,
      reason: "manual-retry",
    });
    if (!rolled) return this.reconcile(submissionId);
    return this.reconcile(submissionId);
  }
}

export async function claimSubmissionHandler(input: {
  submissions: Collection<SubmissionDocument>;
  submissionId: string;
  submissionRunId: string;
  handlerId: string;
  version: number;
}): Promise<SubmissionDocument | null> {
  const now = new Date();
  return input.submissions.findOneAndUpdate(
    {
      _id: input.submissionId,
      "run._id": input.submissionRunId,
      "run.rollover": { $exists: false },
      [`run.handlerStatus.${input.handlerId}.status`]: { $in: ["queued"] },
    } as Document,
    {
      $set: {
        [`run.handlerStatus.${input.handlerId}`]: {
          status: "processing",
          version: input.version,
          updatedAt: now,
        },
        "run.startedAt": now,
        "run.updatedAt": now,
        updatedAt: now,
      },
    } as Document,
    { returnDocument: "after" },
  );
}

export async function isCurrentSubmissionRun(input: {
  submissions: Collection<SubmissionDocument>;
  submissionId: string;
  submissionRunId: string;
}): Promise<boolean> {
  return Boolean(
    await input.submissions.findOne({
      _id: input.submissionId,
      "run._id": input.submissionRunId,
      "run.rollover": { $exists: false },
    } as Document),
  );
}

export async function completeSubmissionHandler(input: {
  submissions: Collection<SubmissionDocument>;
  submissionId: string;
  submissionRunId: string;
  handlerId: string;
  status: "done" | "failed";
  version: number;
  error?: string;
  report?: SubmissionReportPointer;
}): Promise<boolean> {
  const now = new Date();
  const set: Record<string, unknown> = {
    [`run.handlerStatus.${input.handlerId}`]: {
      status: input.status,
      version: input.version,
      updatedAt: now,
      ...(input.error ? { error: input.error } : {}),
    },
    "run.updatedAt": now,
    "run.finishedAt": now,
    updatedAt: now,
  };
  if (input.report) set["run.report"] = input.report;
  const result = await input.submissions.updateOne(
    {
      _id: input.submissionId,
      "run._id": input.submissionRunId,
      "run.rollover": { $exists: false },
      [`run.handlerStatus.${input.handlerId}.status`]: "processing",
    } as Document,
    { $set: set } as Document,
  );
  return result.modifiedCount === 1;
}
