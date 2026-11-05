// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ExperimentView } from "@/lib/experiments";
import { ExperimentStatusCard } from "./ExperimentStatusCard";

afterEach(cleanup);

describe("ExperimentStatusCard", () => {
  it("renders readiness and exact handler progress", () => {
    const experiment: ExperimentView = {
      experimentId: "experiment-1",
      projectId: "project-1",
      metadata: { name: "Compiler comparison" },
      revision: {
        experimentRevisionId: "revision-1",
        revisionNumber: 1,
        memberCount: 2,
      },
      createdAt: "2026-10-15T00:00:00.000Z",
      createdRequestIds: ["request-1", "request-2"],
      readiness: "blocked",
      execution: {
        experimentExecutionId: "execution-1",
        attemptNumber: 3,
        requestCount: 2,
        createdAt: "2026-10-15T00:00:00.000Z",
        requests: [],
        handlerProgress: {
          observations: { status: "done" },
          report: { status: "processing" },
        },
        blocking: [],
      },
      blocking: [
        {
          handlerId: "observations",
          reason: "dependency-failed",
        },
      ],
    };

    render(<ExperimentStatusCard experiment={experiment} />);

    expect(screen.getByText("blocked")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("1/2")).toBeDefined();
  });
});
