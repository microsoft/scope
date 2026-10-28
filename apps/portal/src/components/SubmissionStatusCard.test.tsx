// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Submission } from "@/types";
import { SubmissionStatusCard } from "./SubmissionStatusCard";

afterEach(cleanup);

describe("SubmissionStatusCard", () => {
  it("renders readiness and exact observation progress", () => {
    const submission: Submission = {
      submissionId: "submission-1",
      projectId: "project-1",
      requestIds: ["request-1", "request-2"],
      createdAt: new Date().toISOString(),
      submissionRunId: "submission-run-1",
      attemptNumber: 3,
      readiness: "blocked",
      requests: [
        {
          requestId: "request-1",
          runId: "run-1",
          task: "Task",
          status: "done",
          workerType: "worker",
        },
        {
          requestId: "request-2",
          runId: "run-2",
          task: "Task",
          status: "done",
          workerType: "worker",
        },
      ],
      dependencyProjection: [
        {
          requestId: "request-1",
          runId: "run-1",
          handlerId: "pp-observations",
          state: "ready",
        },
        {
          requestId: "request-2",
          runId: "run-2",
          handlerId: "pp-observations",
          state: "failed",
        },
      ],
      blocking: [
        {
          requestId: "request-2",
          runId: "run-2",
          handlerId: "pp-observations",
          reason: "dependency-failed",
        },
      ],
    };

    render(<SubmissionStatusCard submission={submission} />);

    expect(screen.getByText("blocked")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("1/2")).toBeDefined();
  });
});
