// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  EXPERIMENT_READOUT_SCHEMA_ID,
  EXPERIMENT_READOUT_SCHEMA_VERSION,
  experimentReadoutSchema,
} from "./readout.js";

describe("experimentReadoutSchema", () => {
  it("accepts a one-request readout with empty selected observations", () => {
    expect(experimentReadoutSchema.parse({
      meta: {
        schemaId: EXPERIMENT_READOUT_SCHEMA_ID,
        schemaVersion: EXPERIMENT_READOUT_SCHEMA_VERSION,
        generatedAt: "2026-10-13T12:00:00.000Z",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-1",
      },
      summary: {
        title: "Experiment readout",
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
