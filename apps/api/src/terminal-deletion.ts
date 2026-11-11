// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection, Document } from "mongodb";
import type { ReportDocument, RequestDocument } from "shared";

/** Exact work identities preventing a visibility-only delete. */
export interface DeletionConflict {
  requestId?: string;
  runId?: string;
  reportId?: string;
  handlerId?: string;
  reason: string;
}

export class TerminalDeletionError extends Error {
  readonly status = 409;
  readonly code = "deletion-work-active";

  constructor(readonly conflicts: DeletionConflict[]) {
    super("Only terminal runs with no outstanding post-processing or report work can be deleted");
  }
}

/** Preflight the entire selection before membership changes or tombstones. */
export async function assertTerminalDeletion(
  requests: readonly RequestDocument[],
  reports: Collection<ReportDocument>,
): Promise<void> {
  const conflicts: DeletionConflict[] = [];
  for (const request of requests) {
    if (request.deletedAt) continue;
    const identity = { requestId: request._id, runId: request.run?._id };
    const run = request.run;
    if (run?.status !== "done") {
      conflicts.push({ ...identity, reason: `coding-${run?.status ?? "missing"}` });
      continue;
    }
    for (const [handlerId, handler] of Object.entries(run.handlerStatus ?? {})) {
      if (handler.status === "queued" || handler.status === "processing") {
        conflicts.push({ ...identity, handlerId, reason: `handler-${handler.status}` });
      }
    }
    if (run.postProcessorStatus === "queued" || run.postProcessorStatus === "processing") {
      conflicts.push({ ...identity, reason: `post-processing-${run.postProcessorStatus}` });
    }
    // The scheduler acknowledges the automatic report trigger only after its
    // DAG has drained and the API has durably published all matching reports.
    if (!run.reportsTriggerCompletedAt) {
      conflicts.push({ ...identity, reason: "report-trigger-incomplete" });
    }
    for (const reportId of run.reportPublicationIds ?? []) {
      conflicts.push({ ...identity, reportId, reason: "report-publication-active" });
    }
    if (request.experimentMembershipOperationId) {
      conflicts.push({ ...identity, reason: "membership-publication-active" });
    }
  }
  if (requests.length > 0) {
    const pending = await reports.find({
      deletedAt: { $exists: false },
      status: { $in: ["pending", "generating"] },
      $or: requests.map((request) => ({
        projectId: request.projectId,
        requestId: request._id,
      })),
    } as Document).toArray();
    for (const report of pending) {
      conflicts.push({
        requestId: report.requestId,
        runId: report.runId,
        reportId: report._id,
        reason: `report-${report.status}`,
      });
    }
  }
  if (conflicts.length > 0) throw new TerminalDeletionError(conflicts);
}

/** Compare exact work state without copying large artifact/turn payloads into
 * the write command. Retry and publication/handler claims share these fields. */
export function terminalDeletionFilter(request: RequestDocument): Document {
  return {
    _id: request._id,
    projectId: request.projectId,
    deletedAt: { $exists: false },
    "run._id": request.run?._id,
    "run.status": "done",
    "run.handlerStatus": request.run?.handlerStatus ?? { $exists: false },
    "run.postProcessorStatus": request.run?.postProcessorStatus ?? { $exists: false },
    "run.reportsTriggeredAt": request.run?.reportsTriggeredAt ?? { $exists: false },
    "run.reportsTriggerCompletedAt": request.run?.reportsTriggerCompletedAt,
    "run.reportPublicationIds": request.run?.reportPublicationIds ?? { $exists: false },
    "run.reportPublicationVersion": request.run?.reportPublicationVersion ?? { $exists: false },
    experimentMembershipOperationId: { $exists: false },
  };
}
