// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

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
  membershipFingerprint?: string;
  definitionFingerprint?: string;
  createdAt?: string;
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
  status?: string;
  outcome?: string;
  workerType?: string;
  model?: string;
  profileId?: string;
}

export interface ExperimentExecutionView {
  experimentExecutionId: string;
  attemptNumber: number;
  version?: number;
  readiness?: string;
  requestCount: number;
  requests: ExperimentRequestSummaryView[];
  handlerProgress: Record<string, unknown>;
  blocking: ExperimentBlockerView[];
  currentReport?: { reportId?: string; url?: string; updatedAt?: string };
  createdAt: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  discardedAt?: string;
  discardReason?: string;
  supersededAt?: string;
  supersededByExperimentExecutionId?: string;
  supersededReason?: "rollover" | "retry";
  archivedAt?: string;
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
  return {
    requestId: requiredString(item, "requestId", "experiment request"),
    runId: requiredString(item, "runId", "experiment request"),
    task: optionalString(item, "task"),
    status: optionalString(item, "status"),
    outcome: optionalString(item, "outcome"),
    workerType: optionalString(item, "workerType"),
    model: optionalString(item, "model"),
    profileId: optionalString(item, "profileId"),
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
  const reportValue = execution.currentReport;
  const currentReport =
    reportValue === undefined
      ? undefined
      : (() => {
          const report = record(reportValue, "experiment report");
          return {
            reportId: optionalString(report, "reportId"),
            url: optionalString(report, "url"),
            updatedAt: optionalString(report, "updatedAt"),
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
    blocking,
    currentReport,
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
      execution.supersededReason === "retry"
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
