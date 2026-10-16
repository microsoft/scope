// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  SUBMISSION_READOUT_SCHEMA_ID,
  SUBMISSION_READOUT_SCHEMA_VERSION,
  submissionReadoutSchema,
} from "./readout.js";

describe("submissionReadoutSchema", () => {
  it("accepts a one-request readout with empty selected observations", () => {
    expect(submissionReadoutSchema.parse({
      meta: {
        schemaId: SUBMISSION_READOUT_SCHEMA_ID,
        schemaVersion: SUBMISSION_READOUT_SCHEMA_VERSION,
        generatedAt: "2026-10-13T12:00:00.000Z",
        submissionId: "submission-1",
        submissionRunId: "submission-run-1",
      },
      summary: {
        title: "Submission readout",
        executiveSummary: "The single run completed without selected observations.",
        totalRuns: 1,
        succeededRuns: 1,
        failedRuns: 0,
        passedObservations: 0,
        failedObservations: 0,
      },
      profiles: [{
        requestIds: ["request-1"],
        summary: "One unprofiled request.",
      }],
      runs: [{
        requestId: "request-1",
        runId: "run-1",
        task: "Update the endpoint",
        workerType: "copilot",
        status: "done",
        outcome: "succeeded",
        observations: [],
        trajectoryHighlights: [],
      }],
      findings: [],
      actions: [],
    })).toBeTruthy();
  });
});
