// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineTool } from "@github/copilot-sdk";
import type { ReportDocument, SubmissionRunState } from "shared";

interface SubmissionAttemptResponse extends SubmissionRunState {
  submissionId?: string;
  projectId?: string;
}

export function createSubmissionReportTools(
  apiBaseUrl: string,
  submissionId: string,
  submissionRunId: string,
) {
  const getSubmissionSummary = defineTool("get_submission_summary", {
    description:
      "Get the exact immutable submission attempt, including its request/run vector, dependency projection, handler states, and report pointer.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const response = await fetch(
        `${apiBaseUrl}/api/v1/submissions/${encodeURIComponent(submissionId)}/runs/${encodeURIComponent(submissionRunId)}`,
      );
      if (!response.ok) {
        return {
          error: `Failed to fetch submission attempt: ${response.status} ${response.statusText}`,
        };
      }
      const attempt: SubmissionAttemptResponse = await response.json();
      return {
        submissionId,
        submissionRunId,
        attemptNumber: attempt.attemptNumber,
        requests: attempt.requests,
        dependencyProjection: attempt.dependencyProjection,
        handlerStatus: attempt.handlerStatus,
        blocking: attempt.blocking,
        createdAt: attempt.createdAt,
        finishedAt: attempt.finishedAt,
      };
    },
  });

  const getSubmissionEvidence = defineTool("get_submission_evidence", {
    description:
      "Get the schema-validated structured evidence for this exact submission attempt, including provenance, outcomes, profiles, criteria, trajectories, and observations.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const reportsResponse = await fetch(
        `${apiBaseUrl}/api/v1/submissions/${encodeURIComponent(submissionId)}/reports`,
      );
      if (!reportsResponse.ok) {
        return {
          error: `Failed to list submission reports: ${reportsResponse.status} ${reportsResponse.statusText}`,
        };
      }
      const reports: ReportDocument[] = await reportsResponse.json();
      const evidenceReport = reports
        .filter(
          (report) =>
            report.submissionRunId === submissionRunId &&
            report.reporter?.id === "pp-readout" &&
            report.structuredArtifact,
        )
        .sort(
          (left, right) =>
            new Date(right.createdAt).getTime() -
              new Date(left.createdAt).getTime() ||
            right._id.localeCompare(left._id),
        )[0];
      if (!evidenceReport) {
        return { error: "Structured submission evidence is not available" };
      }
      const response = await fetch(
        `${apiBaseUrl}/api/v1/reports/${encodeURIComponent(evidenceReport._id)}/structured`,
      );
      if (!response.ok) {
        return {
          error: `Failed to fetch structured evidence: ${response.status} ${response.statusText}`,
        };
      }
      const evidence: unknown = await response.json();
      return { reportId: evidenceReport._id, evidence };
    },
  });

  return [getSubmissionSummary, getSubmissionEvidence].map((tool) => ({
    ...tool,
    skipPermission: true,
  }));
}
