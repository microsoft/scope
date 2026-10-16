// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import type {
  CriteriaDocument,
  RequestDocument,
  RunState,
} from "shared";
import {
  composeSubmissionReadout,
  renderSubmissionReadoutMarkdown,
  type SubmissionEvidence,
} from "./readout-builder.js";

function evidence(): SubmissionEvidence {
  const criterion: CriteriaDocument = {
    id: "uses-current-api",
    projectId: "project-1",
    prompt: "Uses the current API",
    kind: "observation",
    subject: "run",
    taxonomyElementId: "dimension:dependency-currency",
    createdAt: new Date(),
  };
  const request = {
    _id: "request-1",
    projectId: "project-1",
    workerType: "copilot",
    profileId: "profile-1",
    profileVersionId: "profile-version-1",
    observations: [criterion.id],
    scenario: { task: "Update the API", criteria: [] },
    createdAt: new Date(),
    priority: 0,
  } satisfies RequestDocument;
  const run = {
    _id: "run-1",
    attemptNumber: 1,
    status: "done",
    outcome: "failed",
    observationResults: [{
      criterionId: criterion.id,
      passed: false,
      feedback: "The deprecated API remained.",
      evaluated: true,
    }],
    turns: [{
      iteration: 1,
      judgeFeedback: "",
      snapshotUrl: "https://example.test/snapshot",
      passed: false,
      timestamp: new Date("2026-10-13T12:00:00.000Z"),
      observationResults: [{
        criterionId: criterion.id,
        passed: true,
        feedback: "The first iteration used the current API.",
        evaluated: true,
      }],
    }],
  } satisfies RunState;
  return {
    submissionId: "submission-1",
    submissionRunId: "submission-run-1",
    runs: [{ request, run, criteria: [criterion], trajectories: [] }],
  };
}

describe("submission readout composition", () => {
  it("preserves mixed run/iteration observations, profiles, and provenance", () => {
    const readout = composeSubmissionReadout(evidence(), {
      title: "Submission readout",
      executiveSummary: "The run failed after mixed observation evidence.",
      profiles: [{
        profileId: "profile-1",
        requestIds: ["request-1"],
        summary: "One profiled run.",
      }],
      runs: [{
        requestId: "request-1",
        runId: "run-1",
        trajectoryHighlights: ["The agent changed approach between iterations."],
      }],
      findings: [{
        id: "finding-1",
        title: "Regression",
        description: "The final state regressed.",
        severity: "high",
        evidence: [{
          requestId: "request-1",
          runId: "run-1",
          iteration: 1,
          criterionId: "uses-current-api",
          excerpt: "The deprecated API remained.",
        }],
      }],
      actions: [{
        id: "action-1",
        title: "Prevent regression",
        priority: "high",
        description: "Add a final-state check.",
        relatedFindingIds: ["finding-1"],
      }],
    }, new Date("2026-10-13T12:00:00.000Z"));

    expect(readout.runs[0].observations).toEqual([
      expect.objectContaining({ subject: "run", passed: false }),
      expect.objectContaining({ subject: "iteration", passed: true }),
    ]);
    expect(readout.findings[0].evidence[0]).toMatchObject({
      submissionRunId: "submission-run-1",
      requestId: "request-1",
      runId: "run-1",
    });
    expect(readout.profiles).toEqual([{
      profileId: "profile-1",
      requestIds: ["request-1"],
      summary: "One profiled run.",
    }]);
    expect(readout.summary.failedRuns).toBe(1);
    expect(readout.summary.passedObservations).toBe(1);
    expect(readout.summary.failedObservations).toBe(1);
    expect(renderSubmissionReadoutMarkdown(readout)).toContain(
      "Schema: `scope.submission-readout@1.0`",
    );
  });

  it("rejects evidence outside the exact vector", () => {
    expect(() => composeSubmissionReadout(evidence(), {
      title: "Submission readout",
      executiveSummary: "Invalid evidence.",
      profiles: [{ requestIds: ["request-1"], summary: "One run." }],
      runs: [{
        requestId: "request-1",
        runId: "run-1",
        trajectoryHighlights: [],
      }],
      findings: [{
        id: "finding-1",
        title: "Invalid",
        description: "References a newer run.",
        severity: "high",
        evidence: [{
          requestId: "request-1",
          runId: "run-newer",
          excerpt: "Not in the vector.",
        }],
      }],
      actions: [],
    })).toThrow("non-vector run");
  });

  it("rejects findings that cite a missing iteration", () => {
    expect(() => composeSubmissionReadout(evidence(), {
      title: "Submission readout",
      executiveSummary: "Invalid iteration evidence.",
      profiles: [],
      runs: [],
      findings: [{
        id: "finding-1",
        title: "Invalid",
        description: "References a missing iteration.",
        severity: "high",
        evidence: [{
          requestId: "request-1",
          runId: "run-1",
          iteration: 2,
          excerpt: "Not in the vector.",
        }],
      }],
      actions: [],
    })).toThrow("unknown iteration 2");
  });

  it("canonically retains every exact-vector profile when synthesis omits it", () => {
    const readout = composeSubmissionReadout(evidence(), {
      title: "Submission readout",
      executiveSummary: "Profile synthesis was omitted.",
      profiles: [],
      runs: [],
      findings: [],
      actions: [],
    });

    expect(readout.profiles).toEqual([{
      profileId: "profile-1",
      requestIds: ["request-1"],
      summary: "1 exact-vector run.",
    }]);
  });
});
