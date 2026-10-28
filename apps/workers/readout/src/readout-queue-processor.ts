// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { DequeuedMessageItem } from "@azure/storage-queue";
import { randomUUID } from "node:crypto";
import {
  BaseQueueProcessor,
  BlobStorage,
  type BaseQueueProcessorConfig,
  type CriteriaDocument,
  EXPERIMENT_READOUT_SCHEMA_ID,
  EXPERIMENT_READOUT_SCHEMA_VERSION,
  type ExperimentDocument,
  type ExperimentExecutionHistoryDocument,
  type ExperimentQueueMessagePayload,
  ExperimentStore,
  type LogEvent,
  type ReportDocument,
  type ReportTemplateVersionDocument,
  type RequestDocument,
  type RunHistoryDocument,
  type RunState,
  TokenManagerClient,
  type VisibilityHeartbeat,
  withRetry,
} from "shared";
import {
  renderExperimentReadoutMarkdown,
  type ExactRunEvidence,
  type ExperimentEvidence,
} from "./readout-builder.js";
import { generateExperimentReadout } from "./readout-generator.js";
import { generateExperimentTemplateReport } from "./experiment-report-generator.js";

const HANDLER_ID = "pp-readout";
const HANDLER_VERSION = 1;

export interface ReadoutQueueProcessorConfig extends BaseQueueProcessorConfig {
  model: string;
  sessionTimeoutMs: number;
  tokenManagerUrl?: string;
}

interface ReadoutQueueMessage extends ExperimentQueueMessagePayload {
  type: "readout";
  projectId: string;
  handlerId: string;
  handlerVersion: number;
  claimToken: string;
  executionVersion: number;
}

interface ExperimentReportQueueMessage extends ExperimentQueueMessagePayload {
  type: "experiment-report";
  projectId: string;
  templateId: string;
  templateVersionId: string;
  claimToken: string;
  executionVersion: number;
  reportId: string;
}

function isReadoutMessage(
  payload: Record<string, unknown> | undefined,
): payload is Record<string, unknown> & ReadoutQueueMessage {
  return payload?.type === "readout" &&
    typeof payload.projectId === "string" &&
    typeof payload.experimentId === "string" &&
    typeof payload.experimentExecutionId === "string" &&
    payload.handlerId === HANDLER_ID &&
    payload.handlerVersion === HANDLER_VERSION &&
    typeof payload.claimToken === "string" &&
    typeof payload.executionVersion === "number";
}

function isExperimentReportMessage(
  payload: Record<string, unknown> | undefined,
): payload is Record<string, unknown> & ExperimentReportQueueMessage {
  return payload?.type === "experiment-report" &&
    typeof payload.projectId === "string" &&
    typeof payload.experimentId === "string" &&
    typeof payload.experimentExecutionId === "string" &&
    typeof payload.templateId === "string" &&
    typeof payload.templateVersionId === "string" &&
    typeof payload.claimToken === "string" &&
    typeof payload.executionVersion === "number" &&
    typeof payload.reportId === "string";
}

export class ReadoutQueueProcessor extends BaseQueueProcessor<ExperimentDocument> {
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
    return typeof payload.experimentId === "string" ? payload.experimentId : "";
  }

  protected override async handleRequest(
    _experiment: ExperimentDocument,
    message: DequeuedMessageItem,
    heartbeat: VisibilityHeartbeat,
    log: (
      level: LogEvent["level"],
      message: string,
      data?: Record<string, unknown>,
    ) => Promise<void>,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const handleExperimentReport = async (
      payload: ExperimentReportQueueMessage,
      message: DequeuedMessageItem,
      heartbeat: VisibilityHeartbeat,
      log: (
        level: LogEvent["level"],
        message: string,
        data?: Record<string, unknown>,
      ) => Promise<void>,
    ): Promise<void> => {
      const store = this.experimentStore();
      const claimed = await withRetry(() =>
        store.claimReportTemplate({
          projectId: payload.projectId,
          experimentId: payload.experimentId,
          experimentExecutionId: payload.experimentExecutionId,
          expectedExecutionVersion: payload.executionVersion,
          templateId: payload.templateId,
          templateVersionId: payload.templateVersionId,
          claimToken: payload.claimToken,
        })
      );
      if (!claimed) {
        await log("info", "Discarding stale or duplicate Experiment report", {
          experimentId: payload.experimentId,
          experimentExecutionId: payload.experimentExecutionId,
          templateId: payload.templateId,
        });
        await this.safeDeleteMessage(message.messageId, heartbeat.stop());
        return;
      }

      try {
        let completionVersion = await this.currentTemplateClaimVersion(payload);
        if (completionVersion === null) return;
        const root = await withRetry(() =>
          this.db.collection("report-templates").findOne({
            projectId: payload.projectId,
            id: payload.templateId,
            subject: "experiment",
            enabled: true,
            deletedAt: { $exists: false },
          })
        );
        if (!root) {
          await withRetry(() =>
            this.db.collection<ReportDocument>("reports").updateOne(
              {
                _id: payload.reportId,
                projectId: payload.projectId,
                experimentExecutionId: payload.experimentExecutionId,
                templateVersionId: payload.templateVersionId,
              },
              {
                $set: {
                  status: "failed",
                  error: "Experiment report template became unavailable",
                  updatedAt: new Date(),
                },
              },
            )
          );
          completionVersion = await this.currentTemplateClaimVersion(payload);
          if (completionVersion !== null) {
            const unavailableVersion = completionVersion;
            await withRetry(() =>
              store.completeReportTemplate({
                projectId: payload.projectId,
                experimentId: payload.experimentId,
                experimentExecutionId: payload.experimentExecutionId,
                expectedExecutionVersion: unavailableVersion,
                templateId: payload.templateId,
                templateVersionId: payload.templateVersionId,
                claimToken: payload.claimToken,
                status: "unavailable",
                error: "Experiment report template became unavailable",
              })
            );
          }
          return;
        }
        const template = await withRetry(() =>
          this.db
            .collection<ReportTemplateVersionDocument>(
              "report-template-versions",
            )
            .findOne({
              _id: payload.templateVersionId,
              projectId: payload.projectId,
              templateId: payload.templateId,
            })
        );
        if (!template) {
          throw new Error(
            `Frozen template version ${payload.templateVersionId} was not found`,
          );
        }
        const evidence = await this.loadEvidence(payload);
        const linkedRunReports = await this.loadLinkedRunReports(
          payload,
          template,
        );
        const githubToken = await this.tokenClient.acquireToken("copilot-sdk");
        completionVersion = await this.currentTemplateClaimVersion(payload);
        if (completionVersion === null) return;
        const model = template.model ?? this.readoutConfig.model;
        const content = await generateExperimentTemplateReport({
          template,
          evidence,
          linkedRunReports,
          model,
          githubToken,
          timeoutMs:
            template.timeoutMs ?? this.readoutConfig.sessionTimeoutMs,
          log,
        });
        completionVersion = await this.currentTemplateClaimVersion(payload);
        if (completionVersion === null) return;
        const now = new Date();
        const persisted = await withRetry(() =>
          this.db.collection<ReportDocument>("reports").updateOne(
            {
              _id: payload.reportId,
              projectId: payload.projectId,
              experimentId: payload.experimentId,
              experimentExecutionId: payload.experimentExecutionId,
              templateId: payload.templateId,
              templateVersionId: payload.templateVersionId,
              status: { $in: ["pending", "generating"] },
            },
            {
              $set: {
                status: "completed",
                content,
                reporter: {
                  id: "experiment-report-generator",
                  name: "Experiment Report Generator",
                  gitHash: process.env.GIT_COMMIT || "unknown",
                  model,
                  agentId: "copilot-sdk",
                  agentVersion:
                    process.env.COPILOT_SDK_VERSION || "unknown",
                },
                updatedAt: now,
              },
            },
          )
        );
        if (persisted.matchedCount === 0) {
          throw new Error(`Experiment report ${payload.reportId} is stale`);
        }
        completionVersion = await this.currentTemplateClaimVersion(payload);
        const completed = completionVersion === null
          ? null
          : await withRetry(() =>
            store.completeReportTemplate({
              projectId: payload.projectId,
              experimentId: payload.experimentId,
              experimentExecutionId: payload.experimentExecutionId,
              expectedExecutionVersion: completionVersion,
              templateId: payload.templateId,
              templateVersionId: payload.templateVersionId,
              claimToken: payload.claimToken,
              status: "done",
              report: {
                reportId: payload.reportId,
                url: `/api/v1/reports/${payload.reportId}`,
                updatedAt: now,
              },
            })
          );
        await log(
          completed ? "info" : "warn",
          completed
            ? "Experiment report completed"
            : "Experiment report remained historical after supersession",
          {
            experimentId: payload.experimentId,
            experimentExecutionId: payload.experimentExecutionId,
            templateId: payload.templateId,
            reportId: payload.reportId,
          },
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        await withRetry(() =>
          this.db.collection<ReportDocument>("reports").updateOne(
            {
              _id: payload.reportId,
              projectId: payload.projectId,
              experimentExecutionId: payload.experimentExecutionId,
              templateVersionId: payload.templateVersionId,
            },
            {
              $set: {
                status: "failed",
                error: errorMessage,
                updatedAt: new Date(),
              },
            },
          )
        );
        const completionVersion = await this.currentTemplateClaimVersion(payload);
        if (completionVersion !== null) {
          await withRetry(() =>
            store.completeReportTemplate({
              projectId: payload.projectId,
              experimentId: payload.experimentId,
              experimentExecutionId: payload.experimentExecutionId,
              expectedExecutionVersion: completionVersion,
              templateId: payload.templateId,
              templateVersionId: payload.templateVersionId,
              claimToken: payload.claimToken,
              status: "failed",
              error: errorMessage,
            })
          );
        }
        await log("error", `Experiment report failed: ${errorMessage}`, {
          experimentId: payload.experimentId,
          experimentExecutionId: payload.experimentExecutionId,
          templateId: payload.templateId,
        });
      } finally {
        await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      }
    };

    if (isExperimentReportMessage(payload)) {
      await handleExperimentReport(payload, message, heartbeat, log);
      return;
    }
    if (!isReadoutMessage(payload)) {
      await log("warn", "Discarding unsupported readout queue payload", {
        payload,
      });
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    const store = this.experimentStore();
    const claimed = await withRetry(() =>
      store.claimHandler({
        projectId: payload.projectId,
        experimentId: payload.experimentId,
        experimentExecutionId: payload.experimentExecutionId,
        expectedExecutionVersion: payload.executionVersion,
        handlerId: payload.handlerId,
        handlerVersion: payload.handlerVersion,
        claimToken: payload.claimToken,
      })
    );
    if (!claimed) {
      await log("info", "Discarding stale or duplicate readout message", {
        experimentId: payload.experimentId,
        experimentExecutionId: payload.experimentExecutionId,
      });
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
      return;
    }

    try {
      let completionVersion = await this.currentClaimVersion(payload);
      if (completionVersion === null) return;
      const evidence = await this.loadEvidence(payload);

      completionVersion = await this.currentClaimVersion(payload);
      if (completionVersion === null) return;
      const githubToken = await this.tokenClient.acquireToken("copilot-sdk");

      completionVersion = await this.currentClaimVersion(payload);
      if (completionVersion === null) return;
      const readout = await generateExperimentReadout({
        evidence,
        model: this.readoutConfig.model,
        githubToken,
        timeoutMs: this.readoutConfig.sessionTimeoutMs,
        log,
      });
      const markdown = renderExperimentReadoutMarkdown(readout);

      completionVersion = await this.currentClaimVersion(payload);
      if (completionVersion === null) return;
      const reportId = randomUUID();
      const structuredUrl = await this.blobStorage.uploadJson(
        `reports/${reportId}/structured.json`,
        readout,
      );

      completionVersion = await this.currentClaimVersion(payload);
      if (completionVersion === null) return;
      const now = new Date();
      const report: ReportDocument = {
        _id: reportId,
        projectId: payload.projectId,
        experimentId: payload.experimentId,
        experimentExecutionId: payload.experimentExecutionId,
        reporter: {
          id: HANDLER_ID,
          name: "Experiment Readout",
          gitHash: process.env.GIT_COMMIT || "unknown",
          model: this.readoutConfig.model,
          agentId: "copilot-sdk",
          agentVersion: process.env.COPILOT_SDK_VERSION || "unknown",
        },
        content: markdown,
        structuredArtifact: {
          schemaId: EXPERIMENT_READOUT_SCHEMA_ID,
          schemaVersion: EXPERIMENT_READOUT_SCHEMA_VERSION,
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

      completionVersion = await this.currentClaimVersion(payload);
      const completed = completionVersion === null
        ? null
        : await withRetry(() =>
          store.completeHandler({
            projectId: payload.projectId,
            experimentId: payload.experimentId,
            experimentExecutionId: payload.experimentExecutionId,
            expectedExecutionVersion: completionVersion,
            handlerId: payload.handlerId,
            handlerVersion: payload.handlerVersion,
            claimToken: payload.claimToken,
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
          experimentId: payload.experimentId,
          experimentExecutionId: payload.experimentExecutionId,
          reportId,
        });
      } else {
        await log("info", "Experiment readout completed", {
          experimentId: payload.experimentId,
          experimentExecutionId: payload.experimentExecutionId,
          reportId,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const completionVersion = await this.currentClaimVersion(payload);
      if (completionVersion !== null) {
        await withRetry(() =>
          store.completeHandler({
            projectId: payload.projectId,
            experimentId: payload.experimentId,
            experimentExecutionId: payload.experimentExecutionId,
            expectedExecutionVersion: completionVersion,
            handlerId: payload.handlerId,
            handlerVersion: payload.handlerVersion,
            claimToken: payload.claimToken,
            status: "failed",
            error: errorMessage,
          })
        );
      }
      await log("error", `Experiment readout failed: ${errorMessage}`, {
        experimentId: payload.experimentId,
        experimentExecutionId: payload.experimentExecutionId,
      });
    } finally {
      await this.safeDeleteMessage(message.messageId, heartbeat.stop());
    }
  }

  private experimentStore(): ExperimentStore {
    return new ExperimentStore({
      experiments: this.collection,
      executions: this.db.collection<ExperimentExecutionHistoryDocument>(
        "experiment-executions",
      ),
      chunks: this.db.collection("experiment-chunks"),
    });
  }

  private async currentClaimVersion(
    payload: ReadoutQueueMessage,
  ): Promise<number | null> {
    const experiment = await withRetry(() =>
      this.experimentStore().get(payload.projectId, payload.experimentId)
    );
    const execution = experiment?.execution;
    const handler = execution?.handlerSummary[payload.handlerId];
    return execution?.experimentExecutionId === payload.experimentExecutionId &&
        !execution.frozenAt &&
        !execution.rollover &&
        handler?.status === "processing" &&
        handler.version === payload.handlerVersion &&
        handler.claimToken === payload.claimToken
      ? execution.version
      : null;
  }

  private async currentTemplateClaimVersion(
    payload: ExperimentReportQueueMessage,
  ): Promise<number | null> {
    const experiment = await withRetry(() =>
      this.experimentStore().get(payload.projectId, payload.experimentId)
    );
    const execution = experiment?.execution;
    const summary = execution?.reportTemplates[payload.templateId];
    return execution?.experimentExecutionId === payload.experimentExecutionId &&
        !execution.frozenAt &&
        !execution.rollover &&
        summary?.status === "processing" &&
        summary.templateVersionId === payload.templateVersionId &&
        summary.claimToken === payload.claimToken
      ? execution.version
      : null;
  }

  private async loadLinkedRunReports(
    payload: ExperimentReportQueueMessage,
    template: ReportTemplateVersionDocument,
  ): Promise<Array<{
    runTemplateId: string;
    requestId: string;
    runId: string;
    reportId: string;
    content: string;
  }>> {
    const trigger = template.trigger;
    if (trigger?.type !== "run-report-templates") return [];
    const linkedTemplateIds = trigger.reportTemplateIds;
    const refs = await withRetry(() =>
      this.experimentStore().readExecutionRequests({
        projectId: payload.projectId,
        experimentId: payload.experimentId,
        experimentExecutionId: payload.experimentExecutionId,
      })
    );
    if (!refs) return [];
    const reports = await withRetry(() =>
      this.db.collection<ReportDocument>("reports").find({
        projectId: payload.projectId,
        status: "completed",
        requestId: { $in: refs.map(({ requestId }) => requestId) },
        runId: { $in: refs.map(({ runId }) => runId) },
        templateId: { $in: linkedTemplateIds },
        content: { $exists: true },
      }).toArray()
    );
    const exactPairs = new Set(
      refs.map(({ requestId, runId }) => `${requestId}\0${runId}`),
    );
    return reports
      .filter(
        (report): report is ReportDocument & {
          requestId: string;
          runId: string;
          templateId: string;
          content: string;
        } =>
          Boolean(
            report.requestId &&
            report.runId &&
            report.templateId &&
            report.content &&
            exactPairs.has(`${report.requestId}\0${report.runId}`),
          ),
      )
      .sort((left, right) =>
        left.templateId.localeCompare(right.templateId) ||
        left.requestId.localeCompare(right.requestId) ||
        left.runId.localeCompare(right.runId)
      )
      .map((report) => ({
        runTemplateId: report.templateId,
        requestId: report.requestId,
        runId: report.runId,
        reportId: report._id,
        content: report.content,
      }));
  }

  private async loadEvidence(
    payload: ReadoutQueueMessage | ExperimentReportQueueMessage,
  ): Promise<ExperimentEvidence> {
    const refs = await withRetry(() =>
      this.experimentStore().readExecutionRequests({
        projectId: payload.projectId,
        experimentId: payload.experimentId,
        experimentExecutionId: payload.experimentExecutionId,
      })
    );
    if (!refs) {
      throw new Error(
        `Experiment execution ${payload.experimentId}/${payload.experimentExecutionId} was not found`,
      );
    }
    const requests = await withRetry(() =>
      this.db.collection<RequestDocument>("requests").find({
        _id: { $in: refs.map((ref) => ref.requestId) },
        projectId: payload.projectId,
      }).toArray()
    );
    const requestById = new Map(requests.map((request) => [request._id, request]));
    const history = this.db.collection<RunHistoryDocument>("runs");
    const exactRuns: Array<{ request: RequestDocument; run: RunState }> = [];
    for (const ref of refs) {
      const request = requestById.get(ref.requestId);
      if (!request) {
        throw new Error(`Exact-vector request ${ref.requestId} was not found`);
      }
      const run = request.run?._id === ref.runId
        ? request.run
        : await withRetry(() =>
          history.findOne({
            _id: ref.runId,
            requestId: ref.requestId,
            projectId: payload.projectId,
          })
        );
      if (!run) {
        throw new Error(
          `Exact-vector run ${ref.requestId}/${ref.runId} was not found`,
        );
      }
      exactRuns.push({ request, run });
    }

    const criterionIds = [
      ...new Set(
        exactRuns.flatMap(({ request, run }) => [
          ...request.scenario.criteria,
          ...(request.observations ?? []),
          ...(run.observationResults ?? []).map((result) => result.criterionId),
          ...(run.turns ?? []).flatMap((turn) =>
            (turn.observationResults ?? []).map((result) => result.criterionId)
          ),
        ]),
      ),
    ];
    const criteria = criterionIds.length === 0
      ? []
      : await withRetry(() =>
        this.db.collection<CriteriaDocument>("criteria").find({
          projectId: payload.projectId,
          id: { $in: criterionIds },
        }).toArray()
      );
    const criteriaById = new Map(
      criteria.map((criterion) => [criterion.id, criterion]),
    );

    const runs: ExactRunEvidence[] = [];
    for (const { request, run } of exactRuns) {
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
            ? [
                withRetry(() => this.blobStorage.downloadJson(turn.atifUrl!))
                  .then((trajectory) => ({
                    iteration: turn.iteration,
                    trajectory,
                  })),
              ]
            : []
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
      experimentId: payload.experimentId,
      experimentExecutionId: payload.experimentExecutionId,
      runs,
    };
  }
}
