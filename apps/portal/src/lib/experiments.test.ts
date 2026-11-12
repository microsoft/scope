// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { experimentDisplayStatus, parseExperimentOperation } from "./experiments";

const resource = {
  experimentId: "experiment-1",
  projectId: "project-1",
  metadata: { name: "Restored experiment" },
  revision: { experimentRevisionId: "revision-1", revisionNumber: 1, memberCount: 0 },
  currentExecution: {
    experimentExecutionId: "execution-1",
    attemptNumber: 1,
    readiness: "done",
    progress: {},
    blockers: [],
    createdAt: "2026-10-16T12:00:00Z",
  },
  createdAt: "2026-10-16T12:00:00Z",
};
const progress = {
  operationId: "operation-1", phase: "restoring", stateVersion: 1,
  progress: { expectedRequests: 1, completedRequests: 0, expectedReports: 0, completedReports: 0 },
  blocking: [],
};

describe("Experiment operation responses", () => {
  it("parses the normal 200 resource and pending 202 progress independently", () => {
    const active = parseExperimentOperation(resource);
    expect(active).toMatchObject({
      experimentId: "experiment-1",
      readiness: "done",
      execution: { experimentExecutionId: "execution-1", attemptNumber: 1 },
    });
    if ("phase" in active) throw new Error("Expected an Experiment resource");
    expect(active.lifecycle).toBeUndefined();
    expect(parseExperimentOperation(progress)).toMatchObject({
      operationId: "operation-1", phase: "restoring",
    });
    expect(() => parseExperimentOperation({ ...progress, phase: "restored" })).toThrow();
  });

  it.each(["deleting", "deleted", "restoring"] as const)("derives %s without replacing canonical readiness", (phase) => {
    const active = parseExperimentOperation({
      ...resource,
      lifecycle: { ...progress, phase },
    });
    if ("phase" in active) throw new Error("Expected an Experiment resource");
    expect(experimentDisplayStatus(active)).toBe(phase);
    expect(active.readiness).toBe("done");
    expect(active.execution.experimentExecutionId).toBe("execution-1");
    expect(experimentDisplayStatus({ ...active, lifecycle: undefined })).toBe("done");
  });
});
