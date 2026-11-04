// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { TaxonomyHandlerSummary } from "@/types";

export const LEGACY_REQUEST_COMPOSITION_DEPRECATION =
  "legacy-request-composition" as const;

export interface ExperimentMetadataView {
  name: string;
  description?: string;
  createdBy?: string;
}

export interface ExperimentRevisionView {
  experimentRevisionId: string;
  revisionNumber: number;
  memberCount: number;
  reportTemplateIds?: string[];
  membershipFingerprint?: string;
  definitionFingerprint?: string;
  createdAt?: string;
}

export interface ExperimentRevisionIdentityView {
  experimentId: string;
  experimentRevisionId: string;
  revisionNumber: number;
}

export interface ExperimentMembershipMutationView {
  experiment: ExperimentView;
  attachedRequestIds: string[];
  detachedRequestIds: string[];
}

export interface ExistingRunExperimentCreateView {
  experiment: ExperimentView;
  requestIds: string[];
}

export interface ExperimentBlockerView {
  handlerId: string;
  reason: string;
  requestId?: string;
  runId?: string;
  error?: string;
}

export interface ExperimentRequestSummaryView {
  requestId: string;
  runId: string;
  task?: string;
  criteria?: string[];
  taskPromptId?: string;
  status?: string;
  outcome?: string;
  workerType?: string;
  model?: string;
  reasoningEffort?: string;
  agentVersion?: string;
  os?: { platform: string; release: string; arch: string };
  mcpServers?: string[];
  skillRevisions?: string[];
  extensions?: string[];
  profileId?: string;
  priority?: number;
  attemptNumber?: number;
  worker?: { instanceId: string; podName?: string };
  lastHeartbeatAt?: string;
  startedAt?: string;
  taxonomyHandler?: TaxonomyHandlerSummary;
}

export interface ExperimentExecutionView {
  experimentExecutionId: string;
  attemptNumber: number;
  version?: number;
  readiness?: string;
  requestCount: number;
  requests: ExperimentRequestSummaryView[];
  handlerProgress: Record<string, unknown>;
  reportTemplates?: Record<string, unknown>;
  blocking: ExperimentBlockerView[];
  report?: { reportId: string; url: string; updatedAt: string };
  createdAt: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  discardedAt?: string;
  discardReason?: string;
  supersededAt?: string;
  supersededByExperimentExecutionId?: string;
  supersededReason?: "rollover" | "retry" | "membership" | "templates";
  archivedAt?: string;
}

export interface ExperimentLifecycleView {
  operationId: string;
  phase: "deleting" | "deleted" | "restoring" | "restored";
  stateVersion: number;
  progress: {
    expectedRequests: number;
    completedRequests: number;
    expectedReports: number;
    completedReports: number;
  };
  blocking: Array<{
    kind: "request" | "report" | "experiment";
    id: string;
    reason: string;
    error?: string;
  }>;
  deleteRequestedAt?: string;
  deleteCompletedAt?: string;
  restoreRequestedAt?: string;
  restoreCompletedAt?: string;
}

export function parseExperimentLifecycle(
  value: unknown,
): ExperimentLifecycleView {
  const item = record(value, "experiment lifecycle");
  const progress = record(item.progress, "experiment lifecycle progress");
  const phase = requiredString(item, "phase", "experiment lifecycle");
  if (
    phase !== "deleting" &&
    phase !== "deleted" &&
    phase !== "restoring" &&
    phase !== "restored"
  ) {
    throw new Error("Invalid experiment lifecycle phase");
  }
  const blocking = Array.isArray(item.blocking)
    ? item.blocking.map((value) => {
        const blocker = record(value, "experiment lifecycle blocker");
        const kind = requiredString(
          blocker,
          "kind",
          "experiment lifecycle blocker",
        );
        if (
          kind !== "request" &&
          kind !== "report" &&
          kind !== "experiment"
        ) {
          throw new Error("Invalid experiment lifecycle blocker kind");
        }
        const blockerKind: "request" | "report" | "experiment" = kind;
        return {
          kind: blockerKind,
          id: requiredString(blocker, "id", "experiment lifecycle blocker"),
          reason: requiredString(
            blocker,
            "reason",
            "experiment lifecycle blocker",
          ),
          error: optionalString(blocker, "error"),
        };
      })
    : [];
  return {
    operationId: requiredString(item, "operationId", "experiment lifecycle"),
    phase,
    stateVersion: requiredNumber(item, "stateVersion", "experiment lifecycle"),
    progress: {
      expectedRequests: requiredNumber(
        progress,
        "expectedRequests",
        "experiment lifecycle progress",
      ),
      completedRequests: requiredNumber(
        progress,
        "completedRequests",
        "experiment lifecycle progress",
      ),
      expectedReports: requiredNumber(
        progress,
        "expectedReports",
        "experiment lifecycle progress",
      ),
      completedReports: requiredNumber(
        progress,
        "completedReports",
        "experiment lifecycle progress",
      ),
    },
    blocking,
    deleteRequestedAt: optionalString(item, "deleteRequestedAt"),
    deleteCompletedAt: optionalString(item, "deleteCompletedAt"),
    restoreRequestedAt: optionalString(item, "restoreRequestedAt"),
    restoreCompletedAt: optionalString(item, "restoreCompletedAt"),
  };
}

export interface ExperimentView {
  experimentId: string;
  projectId: string;
  metadata: ExperimentMetadataView;
  revision: ExperimentRevisionView;
  execution: ExperimentExecutionView;
  readiness?: string;
  blocking: ExperimentBlockerView[];
  createdRequestIds: string[];
  createdAt: string;
  updatedAt?: string;
  finalizedAt?: string;
  deletedAt?: string;
  lifecycle?: ExperimentLifecycleView;
}

export interface ExperimentPageView {
  items: ExperimentView[];
  nextCursor?: string;
}

export interface ExperimentExecutionPageView {
  items: ExperimentExecutionView[];
  nextCursor?: string;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${name} response from Scope`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  name: string,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`Invalid ${name}.${key} response from Scope`);
  }
  return candidate;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined || candidate === null) return undefined;
  if (typeof candidate !== "string") {
    throw new Error(`Invalid ${key} response from Scope`);
  }
  return candidate;
}

function requiredNumber(
  value: Record<string, unknown>,
  key: string,
  name: string,
): number {
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    throw new Error(`Invalid ${name}.${key} response from Scope`);
  }
  return candidate;
}

function parseBlocker(value: unknown): ExperimentBlockerView {
  const item = record(value, "experiment blocker");
  return {
    handlerId: requiredString(item, "handlerId", "experiment blocker"),
    reason: requiredString(item, "reason", "experiment blocker"),
    requestId: optionalString(item, "requestId"),
    runId: optionalString(item, "runId"),
    error: optionalString(item, "error"),
  };
}

function parseRequestSummary(value: unknown): ExperimentRequestSummaryView {
  const item = record(value, "experiment request");
  const osValue = item.os;
  const os = osValue === undefined
    ? undefined
    : (() => {
        const value = record(osValue, "experiment request os");
        return {
          platform: requiredString(value, "platform", "experiment request os"),
          release: requiredString(value, "release", "experiment request os"),
          arch: requiredString(value, "arch", "experiment request os"),
        };
      })();
  const workerValue = item.worker;
  const worker = workerValue === undefined
    ? undefined
    : (() => {
        const value = record(workerValue, "experiment request worker");
        return {
          instanceId: requiredString(
            value,
            "instanceId",
            "experiment request worker",
          ),
          podName: optionalString(value, "podName"),
        };
      })();
  const taxonomyHandlerValue = item.taxonomyHandler;
  const taxonomyHandler = taxonomyHandlerValue === undefined
    ? undefined
    : ((): TaxonomyHandlerSummary => {
        const value = record(
          taxonomyHandlerValue,
          "experiment request taxonomy handler",
        );
        const status = requiredString(
          value,
          "status",
          "experiment request taxonomy handler",
        );
        if (
          status !== "queued" &&
          status !== "processing" &&
          status !== "done" &&
          status !== "failed"
        ) {
          throw new Error("Invalid experiment request taxonomy handler status");
        }
        return {
          status,
          updatedAt: optionalString(value, "updatedAt"),
          error: optionalString(value, "error"),
          resultAvailable: value.resultAvailable === true,
        };
      })();
  const strings = (key: string): string[] | undefined => {
    const candidate = item[key];
    if (candidate === undefined) return undefined;
    if (!Array.isArray(candidate) || candidate.some((value) => typeof value !== "string")) {
      throw new Error(`Invalid experiment request.${key} response from Scope`);
    }
    return candidate;
  };
  return {
    requestId: requiredString(item, "requestId", "experiment request"),
    runId: requiredString(item, "runId", "experiment request"),
    task: optionalString(item, "task"),
    criteria: strings("criteria"),
    taskPromptId: optionalString(item, "taskPromptId"),
    status: optionalString(item, "status"),
    outcome: optionalString(item, "outcome"),
    workerType: optionalString(item, "workerType"),
    model: optionalString(item, "model"),
    reasoningEffort: optionalString(item, "reasoningEffort"),
    agentVersion: optionalString(item, "agentVersion"),
    os,
    mcpServers: strings("mcpServers"),
    skillRevisions: strings("skillRevisions"),
    extensions: strings("extensions"),
    profileId: optionalString(item, "profileId"),
    priority:
      typeof item.priority === "number" ? item.priority : undefined,
    attemptNumber:
      typeof item.attemptNumber === "number" ? item.attemptNumber : undefined,
    worker,
    lastHeartbeatAt: optionalString(item, "lastHeartbeatAt"),
    startedAt: optionalString(item, "startedAt"),
    taxonomyHandler,
  };
}

function parseRequestVector(
  value: unknown,
): { requestCount: number; requests: ExperimentRequestSummaryView[] } {
  if (Array.isArray(value)) {
    const requests = value.map(parseRequestSummary);
    return { requestCount: requests.length, requests };
  }
  const payload = record(value, "experiment request vector");
  const entries = Array.isArray(payload.entries)
    ? payload.entries.map(parseRequestSummary)
    : [];
  const entryCount =
    typeof payload.entryCount === "number" ? payload.entryCount : entries.length;
  return { requestCount: entryCount, requests: entries };
}

export function parseExperimentExecution(
  value: unknown,
): ExperimentExecutionView {
  const execution = record(value, "experiment execution");
  const vector = parseRequestVector(execution.requests ?? []);
  const blockingValue = execution.blockers ?? execution.blocking;
  const blocking = Array.isArray(blockingValue)
    ? blockingValue.map(parseBlocker)
    : [];
  const progressValue =
    execution.progress ??
    execution.handlerProgress ??
    execution.handlerSummary ??
    {};
  const handlerProgress = record(progressValue, "experiment handler progress");
  const reportTemplates = record(
    execution.reportTemplates ?? {},
    "experiment report templates",
  );
  const reportValue = execution.report;
  const report =
    reportValue === undefined
      ? undefined
      : (() => {
          const report = record(reportValue, "experiment report");
          return {
            reportId: requiredString(report, "reportId", "experiment report"),
            url: requiredString(report, "url", "experiment report"),
            updatedAt: requiredString(report, "updatedAt", "experiment report"),
          };
        })();

  return {
    experimentExecutionId: requiredString(
      execution,
      "experimentExecutionId",
      "experiment execution",
    ),
    attemptNumber: requiredNumber(
      execution,
      "attemptNumber",
      "experiment execution",
    ),
    version:
      typeof execution.version === "number" ? execution.version : undefined,
    readiness: optionalString(execution, "readiness"),
    requestCount: vector.requestCount,
    requests: vector.requests,
    handlerProgress,
    reportTemplates,
    blocking,
    report,
    createdAt: requiredString(execution, "createdAt", "experiment execution"),
    updatedAt: optionalString(execution, "updatedAt"),
    startedAt: optionalString(execution, "startedAt"),
    finishedAt: optionalString(execution, "finishedAt"),
    discardedAt: optionalString(execution, "discardedAt"),
    discardReason: optionalString(execution, "discardReason"),
    supersededAt: optionalString(execution, "supersededAt"),
    supersededByExperimentExecutionId: optionalString(
      execution,
      "supersededByExperimentExecutionId",
    ),
    supersededReason:
      execution.supersededReason === "rollover" ||
      execution.supersededReason === "retry" ||
      execution.supersededReason === "membership" ||
      execution.supersededReason === "templates"
        ? execution.supersededReason
        : undefined,
    archivedAt: optionalString(execution, "archivedAt"),
  };
}

export function parseExperiment(value: unknown): ExperimentView {
  const experiment = record(value, "experiment");
  const metadata = record(experiment.metadata, "experiment metadata");
  const revision = record(experiment.revision, "experiment revision");
  const executionValue = experiment.execution ?? experiment.currentExecution;
  const execution = parseExperimentExecution(executionValue);
  const blockingValue = experiment.blocking ?? execution.blocking;
  const blocking = Array.isArray(blockingValue)
    ? blockingValue.map(parseBlocker)
    : [];
  const createdRequestIds = Array.isArray(experiment.createdRequestIds)
    ? experiment.createdRequestIds.map((id) => {
        if (typeof id !== "string") {
          throw new Error("Invalid experiment.createdRequestIds response from Scope");
        }
        return id;
      })
    : [];
  const lifecycleValue = experiment.lifecycle;
  const lifecycle = lifecycleValue === undefined
    ? undefined
    : parseExperimentLifecycle(lifecycleValue);

  return {
    experimentId: requiredString(experiment, "experimentId", "experiment"),
    projectId: requiredString(experiment, "projectId", "experiment"),
    metadata: {
      name: requiredString(metadata, "name", "experiment metadata"),
      description: optionalString(metadata, "description"),
      createdBy: optionalString(metadata, "createdBy"),
    },
    revision: {
      experimentRevisionId: requiredString(
        revision,
        "experimentRevisionId",
        "experiment revision",
      ),
      revisionNumber: requiredNumber(
        revision,
        "revisionNumber",
        "experiment revision",
      ),
      memberCount:
        typeof revision.memberCount === "number"
          ? revision.memberCount
          : execution.requestCount,
      reportTemplateIds: Array.isArray(revision.reportTemplateIds)
        ? revision.reportTemplateIds.filter(
            (id): id is string => typeof id === "string",
          )
        : [],
      membershipFingerprint: optionalString(revision, "membershipFingerprint"),
      definitionFingerprint: optionalString(revision, "definitionFingerprint"),
      createdAt: optionalString(revision, "createdAt"),
    },
    execution,
    readiness:
      optionalString(experiment, "readiness") ?? execution.readiness,
    blocking,
    createdRequestIds,
    createdAt: requiredString(experiment, "createdAt", "experiment"),
    updatedAt: optionalString(experiment, "updatedAt"),
    finalizedAt: optionalString(experiment, "finalizedAt"),
    deletedAt: optionalString(experiment, "deletedAt"),
    lifecycle,
  };
}

export function parseExperimentPage(value: unknown): ExperimentPageView {
  const page = record(value, "experiment page");
  const items = page.data ?? page.items;
  if (!Array.isArray(items)) {
    throw new Error("Invalid experiment page items response from Scope");
  }
  return {
    items: items.map(parseExperiment),
    nextCursor: optionalString(page, "nextCursor"),
  };
}

export function parseExperimentExecutionPage(
  value: unknown,
): ExperimentExecutionPageView {
  const page = record(value, "experiment execution page");
  const items = page.data ?? page.items;
  if (!Array.isArray(items)) {
    throw new Error("Invalid experiment execution page items response from Scope");
  }
  return {
    items: items.map(parseExperimentExecution),
    nextCursor: optionalString(page, "nextCursor"),
  };
}
