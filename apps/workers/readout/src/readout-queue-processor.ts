// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { DequeuedMessageItem } from "@azure/storage-queue";
import { randomUUID } from "node:crypto";
import {
  BaseQueueProcessor,
  BlobStorage,
  type BaseQueueProcessorConfig,
  type CriteriaDocument,
  type LogEvent,
  type ReportDocument,
  type RequestDocument,
  type RunHistoryDocument,
  type SubmissionDocument,
  type SubmissionQueueMessagePayload,
  TokenManagerClient,
  claimSubmissionHandler,
  completeSubmissionHandler,
  isCurrentSubmissionRun,
  SUBMISSION_READOUT_SCHEMA_ID,
  SUBMISSION_READOUT_SCHEMA_VERSION,
  type VisibilityHeartbeat,
  withRetry,
} from "shared";
import {
  renderSubmissionReadoutMarkdown,
  type ExactRunEvidence,
  type SubmissionEvidence,
} from "./readout-builder.js";
import { generateSubmissionReadout } from "./readout-generator.js";

const HANDLER_ID = "pp-readout";
const HANDLER_VERSION = 1;

export interface ReadoutQueueProcessorConfig extends BaseQueueProcessorConfig {
  model: string;
  sessionTimeoutMs: number;
  tokenManagerUrl?: string;
}

function isReadoutMessage(
  payload: Record<string, unknown> | undefined,
): payload is Record<string, unknown> & SubmissionQueueMessagePayload {
  return payload?.type === "readout" &&
    typeof payload.submissionId === "string" &&
    typeof payload.submissionRunId === "string";
}

export class ReadoutQueueProcessor extends BaseQueueProcessor<SubmissionDocument> {
  private readonly readoutConfig: ReadoutQueueProcessorConfig;
  private readonly tokenClient: TokenManagerClient;
  private readonly blobStorage: BlobStorage;

  constructor(config: ReadoutQueueProcessorConfig) {
    super(config, "readout-handler");
    this.readoutConfig = config;
    this.tokenClient = new TokenManagerClient(config.tokenManagerUrl);
    this.blobStorage = new BlobStorage({
      storageAccountName: config.storageAccountName,
      storageConnectionString: config.storageConnectionString,
    });
  }

  protected override extractDocumentId(payload: Record<string, unknown>): string {
    return typeof payload.submissionId === "string" ? payload.submissionId : "";
  }

  protected override async handleRequest(
    _submission: SubmissionDocument,
    message: DequeuedMessageItem,
    heartbeat: VisibilityHeartbeat,
    log: (
      level: LogEvent["level"],
      message: string,
      data?: Record<string, unknown>,
    ) => Promise<void>,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    if (!isReadoutMessage(payload)) {
      await log("warn", "Discarding unsupported readout queue payload", { payload });
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }
    const { submissionId, submissionRunId } = payload;
    const claimed = await withRetry(() =>
      claimSubmissionHandler({
        submissions: this.collection,
        submissionId,
        submissionRunId,
        handlerId: HANDLER_ID,
        version: HANDLER_VERSION,
      })
    );
    if (!claimed) {
      await log("info", "Discarding stale or duplicate readout message", {
        submissionId,
        submissionRunId,
      });
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    try {
      if (!(await this.isCurrent(submissionId, submissionRunId))) return;
      const evidence = await this.loadEvidence(claimed);

      if (!(await this.isCurrent(submissionId, submissionRunId))) return;
      const githubToken = await this.tokenClient.acquireToken("copilot-sdk");

      if (!(await this.isCurrent(submissionId, submissionRunId))) return;
      const readout = await generateSubmissionReadout({
        evidence,
        model: this.readoutConfig.model,
        githubToken,
        timeoutMs: this.readoutConfig.sessionTimeoutMs,
        log,
      });
      const markdown = renderSubmissionReadoutMarkdown(readout);

      if (!(await this.isCurrent(submissionId, submissionRunId))) return;
      const reportId = randomUUID();
      const structuredUrl = await this.blobStorage.uploadJson(
        `reports/${reportId}/structured.json`,
        readout,
      );

      if (!(await this.isCurrent(submissionId, submissionRunId))) return;
      const now = new Date();
      const report: ReportDocument = {
        _id: reportId,
        projectId: claimed.projectId,
        submissionId,
        submissionRunId,
        reporter: {
          id: HANDLER_ID,
          name: "Submission Readout",
          gitHash: process.env.GIT_COMMIT || "unknown",
          model: this.readoutConfig.model,
          agentId: "copilot-sdk",
          agentVersion: process.env.COPILOT_SDK_VERSION || "unknown",
        },
        content: markdown,
        structuredArtifact: {
          schemaId: SUBMISSION_READOUT_SCHEMA_ID,
          schemaVersion: SUBMISSION_READOUT_SCHEMA_VERSION,
          contentType: "application/json",
          url: structuredUrl,
        },
        status: "completed",
        createdAt: now,
        updatedAt: now,
      };
      await withRetry(() =>
        this.db.collection<ReportDocument>("reports").insertOne(report)
      );

      const completed = await withRetry(() =>
        completeSubmissionHandler({
          submissions: this.collection,
          submissionId,
          submissionRunId,
          handlerId: HANDLER_ID,
          version: HANDLER_VERSION,
          status: "done",
          report: {
            reportId,
            url: `/api/v1/reports/${reportId}`,
            updatedAt: now,
          },
        })
      );
      if (!completed) {
        await log("warn", "Readout report remained historical after supersession", {
          submissionId,
          submissionRunId,
          reportId,
        });
      } else {
        await log("info", "Submission readout completed", {
          submissionId,
          submissionRunId,
          reportId,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (await this.isCurrent(submissionId, submissionRunId)) {
        await withRetry(() =>
          completeSubmissionHandler({
            submissions: this.collection,
            submissionId,
            submissionRunId,
            handlerId: HANDLER_ID,
            version: HANDLER_VERSION,
            status: "failed",
            error: errorMessage,
          })
        );
      }
      await log("error", `Submission readout failed: ${errorMessage}`, {
        submissionId,
        submissionRunId,
      });
    } finally {
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
    }
  }

  private isCurrent(
    submissionId: string,
    submissionRunId: string,
  ): Promise<boolean> {
    return withRetry(() =>
      isCurrentSubmissionRun({
        submissions: this.collection,
        submissionId,
        submissionRunId,
      })
    );
  }

  private async loadEvidence(
    submission: SubmissionDocument,
  ): Promise<SubmissionEvidence> {
    const requests = await withRetry(() =>
      this.db.collection<RequestDocument>("requests").find({
        _id: { $in: submission.run.requests.map((ref) => ref.requestId) },
        projectId: submission.projectId,
      }).toArray()
    );
    const requestById = new Map(requests.map((request) => [request._id, request]));
    const history = this.db.collection<RunHistoryDocument>("runs");
    const exactRuns: Array<{ request: RequestDocument; run: RunHistoryDocument | RequestDocument["run"] }> = [];
    for (const ref of submission.run.requests) {
      const request = requestById.get(ref.requestId);
      if (!request) throw new Error(`Exact-vector request ${ref.requestId} was not found`);
      const run = request.run?._id === ref.runId
        ? request.run
        : await withRetry(() => history.findOne({
          _id: ref.runId,
          requestId: ref.requestId,
          projectId: submission.projectId,
        }));
      if (!run) {
        throw new Error(`Exact-vector run ${ref.requestId}/${ref.runId} was not found`);
      }
      exactRuns.push({ request, run });
    }

    const criterionIds = [
      ...new Set(
        exactRuns.flatMap(({ request, run }) => [
          ...request.scenario.criteria,
          ...(request.observations ?? []),
          ...(run?.observationResults ?? []).map((result) => result.criterionId),
          ...(run?.turns ?? []).flatMap((turn) =>
            (turn.observationResults ?? []).map((result) => result.criterionId)
          ),
        ]),
      ),
    ];
    const criteria = criterionIds.length === 0
      ? []
      : await withRetry(() =>
        this.db.collection<CriteriaDocument>("criteria").find({
          projectId: submission.projectId,
          id: { $in: criterionIds },
        }).toArray()
      );
    const criteriaById = new Map(criteria.map((criterion) => [criterion.id, criterion]));

    const runs: ExactRunEvidence[] = [];
    for (const { request, run } of exactRuns) {
      if (!run) continue;
      const runCriterionIds = new Set([
        ...request.scenario.criteria,
        ...(request.observations ?? []),
        ...(run.observationResults ?? []).map((result) => result.criterionId),
        ...(run.turns ?? []).flatMap((turn) =>
          (turn.observationResults ?? []).map((result) => result.criterionId)
        ),
      ]);
      const trajectories = await Promise.all(
        (run.turns ?? []).flatMap((turn) =>
          turn.atifUrl
            ? [withRetry(() =>
              this.blobStorage.downloadJson(turn.atifUrl!)
            ).then((trajectory) => ({
              iteration: turn.iteration,
              trajectory,
            }))]
            : [],
        ),
      );
      runs.push({
        request,
        run,
        criteria: [...runCriterionIds].flatMap((id) => {
          const criterion = criteriaById.get(id);
          return criterion ? [criterion] : [];
        }),
        trajectories,
      });
    }
    return {
      submissionId: submission._id,
      submissionRunId: submission.run._id,
      runs,
    };
  }
}
