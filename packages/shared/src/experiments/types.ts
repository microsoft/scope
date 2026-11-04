// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export const EXPERIMENT_STORAGE_PROFILE_VERSION = "cosmos-mongo-2mb-v1" as const;
export const EXPERIMENT_REQUEST_BUCKET_ASSIGNMENT_VERSION =
  "sha256-mod-v1" as const;

export type ExperimentStorageProfileVersion =
  typeof EXPERIMENT_STORAGE_PROFILE_VERSION;

export interface InlineFixedPayload<T> {
  storage: "inline";
  entryCount: number;
  payloadFingerprint: string;
  payloadVersion: number;
  entries: T[];
}

export interface ChunkedFixedPayload<T> {
  storage: "chunked";
  entryCount: number;
  payloadFingerprint: string;
  payloadVersion: number;
  assignmentVersion: typeof EXPERIMENT_REQUEST_BUCKET_ASSIGNMENT_VERSION;
  bucketCount: number;
  chunkIds: string[];
}

export type FixedPayload<T> =
  | InlineFixedPayload<T>
  | ChunkedFixedPayload<T>;

export type ExperimentLifecyclePhase =
  | "deleting"
  | "deleted"
  | "restoring"
  | "restored";

export type ExperimentLifecycleTargetKind = "request" | "report";

export interface ExperimentLifecycleTarget {
  kind: ExperimentLifecycleTargetKind;
  id: string;
}

export interface ExperimentLifecycleBlocker {
  kind: ExperimentLifecycleTargetKind | "experiment";
  id: string;
  reason: "target-missing" | "target-conflict" | "reconciliation-failed";
  error?: string;
}

export interface ExperimentLifecycleProgress {
  expectedRequests: number;
  completedRequests: number;
  expectedReports: number;
  completedReports: number;
}

export interface ExperimentLifecycleState {
  operationId: string;
  phase: ExperimentLifecyclePhase;
  stateVersion: number;
  targets: FixedPayload<ExperimentRequestState>;
  targetFingerprint: string;
  progress: ExperimentLifecycleProgress;
  blocking: ExperimentLifecycleBlocker[];
  deleteRequestedAt: Date;
  deleteCompletedAt?: Date;
  restoreRequestedAt?: Date;
  restoreCompletedAt?: Date;
}

export type ExperimentDependencyState =
  | "waiting"
  | "ready"
  | "failed"
  | "blocked";

export interface ExperimentDependencyProjection {
  handlerId: string;
  state: ExperimentDependencyState;
  version?: number;
  updatedAt?: Date;
  error?: string;
}

export type ExperimentBlockerReason =
  | "request-missing"
  | "run-changed"
  | "dependency-not-ready"
  | "dependency-failed"
  | "dependency-blocked";

export interface ExperimentBlocker {
  requestId?: string;
  runId?: string;
  handlerId: string;
  reason: ExperimentBlockerReason;
  error?: string;
}

/** Bounded, nonrecursive leaf stored in an experiment execution request vector. */
export interface ExperimentRequestState {
  requestId: string;
  runId: string;
  dependencies: ExperimentDependencyProjection[];
  blockers: ExperimentBlocker[];
}

export interface ExperimentMetadata {
  name: string;
  description?: string;
  createdBy?: string;
}

export interface ExperimentTaxonomySelection {
  taxonomyRevisionId: string;
  ref: string;
  contentSha256: string;
}

export interface ExperimentRevision {
  experimentRevisionId: string;
  revisionNumber: number;
  memberCount: number;
  membershipFingerprint: string;
  reportTemplateIds: string[];
  taxonomy?: ExperimentTaxonomySelection;
  definitionFingerprint: string;
  createdAt: Date;
}

export type ExperimentHandlerStatus =
  | "queued"
  | "processing"
  | "done"
  | "failed";

export interface ExperimentHandlerSummary {
  status: ExperimentHandlerStatus;
  version: number;
  claimToken?: string;
  updatedAt: Date;
  error?: string;
}

export interface ExperimentRolloverClaim {
  nextExecution: ExperimentExecution;
  nextRevision?: ExperimentRevision;
  reason: "rollover" | "retry" | "membership" | "templates";
  claimedAt: Date;
}

export interface ExperimentRequestStateUpdateClaim {
  updateId: string;
  expectedPayloadFingerprint: string;
  nextPayloadFingerprint: string;
  claimedAt: Date;
}

export interface ExperimentReportReference {
  reportId: string;
  url: string;
  updatedAt: Date;
}

export type ExperimentTemplateReportStatus =
  | "waiting"
  | "not-applicable"
  | "unavailable"
  | "queued"
  | "processing"
  | "done"
  | "failed";

export interface ExperimentTemplateReportBlocker {
  requestId?: string;
  runId?: string;
  runTemplateId?: string;
  reason:
    | "run-template-unused"
    | "run-report-pending"
    | "run-report-failed"
    | "template-unavailable";
  error?: string;
}

export interface ExperimentTemplateReportSummary {
  templateId: string;
  templateVersionId?: string;
  templateVersion?: number;
  templateContentFingerprint?: string;
  source: "always" | "linked" | "selected";
  status: ExperimentTemplateReportStatus;
  claimToken?: string;
  matchingRunCount: number;
  blockers: ExperimentTemplateReportBlocker[];
  report?: ExperimentReportReference;
  updatedAt: Date;
  error?: string;
}

export interface ExperimentExecution {
  experimentExecutionId: string;
  attemptNumber: number;
  version: number;
  requests: FixedPayload<ExperimentRequestState>;
  vectorFingerprint: string;
  taxonomy?: ExperimentTaxonomySelection;
  handlerSummary: Record<string, ExperimentHandlerSummary>;
  reportTemplates: Record<string, ExperimentTemplateReportSummary>;
  blocking: ExperimentBlocker[];
  report?: ExperimentReportReference;
  taxonomyReadout?: {
    status: "processing" | "done" | "failed";
    claimToken?: string;
    experimentExecutionId: string;
    taxonomyRevisionId: string;
    jsonUrl?: string;
    markdownUrl?: string;
    updatedAt: Date;
    error?: string;
  };
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  frozenAt?: Date;
  discardedAt?: Date;
  discardReason?: string;
  supersededAt?: Date;
  supersededByExperimentExecutionId?: string;
  supersededReason?: "rollover" | "retry" | "membership" | "templates";
  requestStateUpdate?: ExperimentRequestStateUpdateClaim;
  rollover?: ExperimentRolloverClaim;
}

export interface ExperimentDocument {
  _id: string;
  experimentId: string;
  projectId: string;
  metadata: ExperimentMetadata;
  storageProfileVersion: ExperimentStorageProfileVersion;
  stateVersion: number;
  revision: ExperimentRevision;
  execution: ExperimentExecution;
  createdAt: Date;
  updatedAt: Date;
  finalizedAt?: Date;
  deletedAt?: Date;
  lifecycle?: ExperimentLifecycleState;
}

export interface ExperimentExecutionHistoryDocument
  extends Omit<ExperimentExecution, "rollover"> {
  _id: string;
  experimentId: string;
  projectId: string;
  storageProfileVersion: ExperimentStorageProfileVersion;
  revision: ExperimentRevision;
  archivedAt: Date;
}

export interface ExperimentPage {
  experiments: ExperimentDocument[];
  nextCursor?: string;
}

export type ExperimentRequestStateUpdateResult =
  | {
      status: "applied";
      experiment: ExperimentDocument;
      requests: ExperimentRequestState[];
    }
  | {
      status: "stale";
      reason: "experiment" | "execution" | "version" | "frozen";
    }
  | {
      status: "contention";
      activeUpdateId?: string;
    }
  | {
      status: "invariant";
      message: string;
    }
  | {
      status: "partial-failure";
      updateId: string;
      updatedChunkIds: string[];
      message: string;
      retryable: true;
    };
